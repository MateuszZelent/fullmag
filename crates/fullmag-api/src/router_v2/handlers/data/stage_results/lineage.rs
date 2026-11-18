//! Bounded comparison of a consumed predecessor with later successful results.

use std::collections::{BTreeMap, BTreeSet};

use fullmag_authoring::StudyPlan;
use fullmag_session::{FmsRunIntent, SessionStore};

use super::{accepted_study_metadata, AuthoredStudy};
use crate::accepted_field_materialization_worker::terminal_evidence_for_final_state;
use crate::live_accepted_continuation::list_published_final_states;
use crate::live_execution_binding::verified_history_run_spec;
use crate::schemas::stage_results::{
    StudyResultInitialState, StudyResultInitialStateSource, StudyResultInputSelection,
    StudyResultPredecessorRelation,
};

const MAX_PREDECESSOR_PROBES: usize = 32;
const MAX_CANDIDATE_INTENTS: usize = 256;
const MAX_ANCESTRY_DEPTH: usize = 32;
const MAX_ANCESTRY_STUDY_BYTES: u64 = 8 * 1024 * 1024;

type StageCase = (String, String, String);
type ConsumedState = (StageCase, String, String);

#[derive(Clone)]
struct SavedOutput {
    artifact_id: String,
    state_sha256: String,
    layout_sha256: String,
    admitted_input_sha256: String,
}

#[derive(Clone)]
enum Probe {
    NoPublishedState,
    Unavailable,
    Saved(SavedOutput),
}

pub(super) struct HistoryLineage<'a> {
    store: &'a SessionStore,
    // This list has already been limited to the verified workspace lineage.
    intents: &'a [FmsRunIntent],
    by_run_id: BTreeMap<&'a str, &'a FmsRunIntent>,
    remaining_probes: usize,
    remaining_study_bytes: u64,
    studies: BTreeMap<String, Option<StudyPlan>>,
    cached: BTreeMap<StageCase, Probe>,
    saved_inputs: BTreeMap<ConsumedState, Option<StudyResultInitialStateSource>>,
}

impl<'a> HistoryLineage<'a> {
    pub(super) fn new(store: &'a SessionStore, intents: &'a [FmsRunIntent]) -> Self {
        Self {
            store,
            intents,
            by_run_id: intents
                .iter()
                .map(|intent| (intent.run_id.as_str(), intent))
                .collect(),
            remaining_probes: MAX_PREDECESSOR_PROBES,
            remaining_study_bytes: MAX_ANCESTRY_STUDY_BYTES,
            studies: BTreeMap::new(),
            cached: BTreeMap::new(),
            saved_inputs: BTreeMap::new(),
        }
    }

    pub(super) fn predecessor_relation(
        &mut self,
        authored: &AuthoredStudy,
        initial_state: &StudyResultInitialState,
    ) -> StudyResultPredecessorRelation {
        use StudyResultPredecessorRelation::*;
        let mut source = initial_state.source.clone();
        let mut seen = BTreeSet::new();
        let mut direct_output_repeated = false;
        let mut incomplete = false;
        for depth in 0..MAX_ANCESTRY_DEPTH {
            let StudyResultInitialStateSource::StageResult {
                run_id,
                step_id,
                case_id,
                artifact_id,
                content_sha256,
                selection: StudyResultInputSelection::Predecessor,
            } = source
            else {
                return match (depth, incomplete, direct_output_repeated) {
                    (0, _, _) => NotApplicable,
                    (_, true, _) => Unavailable,
                    (_, _, true) => NewerSameOutput,
                    _ => NoLaterMatchingInput,
                };
            };
            let Some(origin) = self.by_run_id.get(run_id.as_str()).copied() else {
                break;
            };
            let stage = (run_id, step_id, case_id);
            if !seen.insert(stage.clone()) {
                break;
            }
            let (_, step_id, case_id) = &stage;
            match self.probe(origin, step_id, case_id) {
                Probe::Saved(saved) => {
                    if saved.artifact_id != artifact_id || saved.state_sha256 != content_sha256 {
                        break;
                    }
                    match self.compare_later_output(authored, origin, step_id, case_id, &saved) {
                        NewerDifferentOutput if depth == 0 => return NewerDifferentOutput,
                        NewerDifferentOutput => return EarlierPredecessorChanged,
                        NewerSameOutput if depth == 0 => direct_output_repeated = true,
                        Unavailable => incomplete = true,
                        _ => {}
                    }
                }
                Probe::Unavailable => incomplete = true,
                Probe::NoPublishedState => break,
            }
            let Some(parent) = self.saved_input(origin, (stage, artifact_id, content_sha256))
            else {
                break;
            };
            source = parent;
        }
        Unavailable
    }

    fn compare_later_output(
        &mut self,
        authored: &AuthoredStudy,
        origin: &FmsRunIntent,
        step_id: &str,
        case_id: &str,
        saved: &SavedOutput,
    ) -> StudyResultPredecessorRelation {
        use StudyResultPredecessorRelation::*;
        let intents = self.intents;
        let authored_step = if is_compiled(origin) {
            let Some(id) = authored.compiled_stage_ids.get(step_id) else {
                return Unavailable;
            };
            id.as_str()
        } else {
            step_id
        };
        if !authored.stage_ids.contains(authored_step) {
            return Unavailable;
        }
        let Ok(compiled_step) = fullmag_application::script_execution_id(authored_step, 0) else {
            return Unavailable;
        };
        // Run intents are newest first. Inspect equal timestamps as a group
        // so an arbitrary run ID order can never decide between results.
        let mut later = None;
        for (index, candidate) in intents
            .iter()
            .take_while(|run| run.accepted_at >= origin.accepted_at)
            .enumerate()
        {
            if later
                .as_ref()
                .is_some_and(|(at, _)| &candidate.accepted_at < at)
            {
                break;
            }
            if index == MAX_CANDIDATE_INTENTS {
                return Unavailable;
            }
            if candidate.run_id == origin.run_id {
                continue;
            }
            let candidate_step = if is_compiled(candidate) {
                compiled_step.as_str()
            } else if authored_step.contains(['/', '\\']) {
                continue;
            } else {
                authored_step
            };
            match self.probe(candidate, candidate_step, case_id) {
                Probe::NoPublishedState => {}
                Probe::Unavailable => return Unavailable,
                Probe::Saved(output)
                    if output.admitted_input_sha256 == saved.admitted_input_sha256
                        && output.layout_sha256 == saved.layout_sha256 =>
                {
                    if candidate.accepted_at == origin.accepted_at || later.is_some() {
                        return Unavailable;
                    }
                    later = Some((candidate.accepted_at, output.state_sha256));
                }
                Probe::Saved(_) => {}
            }
        }
        match later {
            Some((_, digest)) if digest == saved.state_sha256 => NewerSameOutput,
            Some(_) => NewerDifferentOutput,
            None => NoLaterMatchingInput,
        }
    }

    fn saved_input(
        &mut self,
        origin: &FmsRunIntent,
        consumed: ConsumedState,
    ) -> Option<StudyResultInitialStateSource> {
        if let Some(cached) = self.saved_inputs.get(&consumed) {
            return cached.clone();
        }
        if self.remaining_probes == 0 {
            return None;
        }
        self.remaining_probes -= 1;
        let source = self.read_saved_input(origin, &consumed);
        self.saved_inputs.insert(consumed, source.clone());
        source
    }

    fn read_saved_input(
        &mut self,
        origin: &FmsRunIntent,
        ((run_id, step_id, case_id), artifact_id, digest): &ConsumedState,
    ) -> Option<StudyResultInitialStateSource> {
        let specification = verified_history_run_spec(origin).ok()?;
        let published =
            list_published_final_states(self.store, run_id, &[step_id.as_str()]).ok()??;
        let result = published.outputs.iter().find(|result| {
            result.identity.step_id == *step_id
                && result.identity.case_id == *case_id
                && result.output.artifact_id == *artifact_id
                && result.output.content_sha256 == *digest
        })?;
        if !self.store.cas().contains(&result.output.object_ref) {
            return None;
        }
        let task = published
            .run_catalog
            .tasks
            .iter()
            .find(|task| task.task_id == result.identity.task_id)?;
        let store = self.store;
        let remaining_study_bytes = &mut self.remaining_study_bytes;
        let study = self
            .studies
            .entry(run_id.clone())
            .or_insert_with(|| {
                accepted_study_metadata(store, origin, &specification, remaining_study_bytes)
            })
            .as_ref()?;
        crate::live_stage_initial_state::describe_result_initial_state(
            store,
            &specification,
            study,
            step_id,
            task,
            &published.run_catalog,
            &published.artifact_catalog,
        )
        .map(|initial| initial.source)
    }

    fn probe(&mut self, intent: &FmsRunIntent, step_id: &str, case_id: &str) -> Probe {
        if intent
            .specification
            .pointer("/parameters/live_workspace/step_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|selected| selected != step_id)
        {
            return Probe::NoPublishedState;
        }
        let key = (
            intent.run_id.clone(),
            step_id.to_owned(),
            case_id.to_owned(),
        );
        if let Some(cached) = self.cached.get(&key) {
            return cached.clone();
        }
        if self.remaining_probes == 0 {
            return Probe::Unavailable;
        }
        self.remaining_probes -= 1;
        let result = self
            .read(intent, step_id, case_id)
            .unwrap_or(Probe::Unavailable);
        self.cached.insert(key, result.clone());
        result
    }

    fn read(&self, intent: &FmsRunIntent, step_id: &str, case_id: &str) -> Option<Probe> {
        verified_history_run_spec(intent).ok()?;
        let Some(published) =
            list_published_final_states(self.store, &intent.run_id, &[step_id]).ok()?
        else {
            return Some(Probe::NoPublishedState);
        };
        let Some(result) = published.outputs.iter().find(|result| {
            result.identity.step_id == step_id && result.identity.case_id == case_id
        }) else {
            return Some(Probe::NoPublishedState);
        };
        if result.output.codec_id != fullmag_application::STUDY_MAGNETIZATION_CODEC_ID
            || result.output.codec_version != fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION
            || !self.store.cas().contains(&result.output.object_ref)
        {
            return None;
        }
        let task = published
            .run_catalog
            .tasks
            .iter()
            .find(|task| task.task_id == result.identity.task_id)?;
        let record = terminal_evidence_for_final_state(
            self.store,
            &published.artifact_catalog,
            task,
            step_id,
            &result.output.object_ref,
        )?;
        Some(Probe::Saved(SavedOutput {
            artifact_id: result.output.artifact_id.clone(),
            state_sha256: result.output.content_sha256.clone(),
            layout_sha256: record.layout_sha256,
            admitted_input_sha256: record.admitted_input_sha256?,
        }))
    }
}

fn is_compiled(intent: &FmsRunIntent) -> bool {
    intent
        .specification
        .pointer("/study/plan_version")
        .and_then(serde_json::Value::as_str)
        == Some(fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_authoring::SceneDocument;
    use serde_json::json;

    fn run(run_id: &str, timestamp: i64) -> FmsRunIntent {
        let mut intent = FmsRunIntent::new(run_id, run_id, json!({}));
        intent.accepted_at = chrono::DateTime::from_timestamp(timestamp, 0).unwrap();
        intent
    }

    fn key(run_id: &str) -> StageCase {
        stage_case(run_id, "relax-a")
    }

    fn stage_case(run_id: &str, step_id: &str) -> StageCase {
        (run_id.to_owned(), step_id.to_owned(), "default".into())
    }

    fn predecessor(
        run_id: &str,
        step_id: &str,
        artifact_id: &str,
        digest: &str,
    ) -> StudyResultInitialStateSource {
        StudyResultInitialStateSource::StageResult {
            run_id: run_id.into(),
            step_id: step_id.into(),
            case_id: "default".into(),
            artifact_id: artifact_id.into(),
            content_sha256: digest.into(),
            selection: StudyResultInputSelection::Predecessor,
        }
    }

    fn output(artifact: &str, digest: &str, input: &str) -> Probe {
        Probe::Saved(SavedOutput {
            artifact_id: artifact.into(),
            state_sha256: digest.into(),
            layout_sha256: "same-layout".into(),
            admitted_input_sha256: input.into(),
        })
    }

    #[test]
    fn earlier_rerun_reaches_descendants_and_stops_at_a_reset_or_an_explicit_seed() {
        use StudyResultPredecessorRelation::*;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let mut scene = SceneDocument::default();
        scene.study.stages = serde_json::from_value(json!([
            {"kind": "relax", "entrypoint_kind": "test", "stage_id": "relax-a"},
            {"kind": "relax", "entrypoint_kind": "test", "stage_id": "relax-b"},
            {"kind": "relax", "entrypoint_kind": "test", "stage_id": "relax-c"}
        ]))
        .unwrap();
        let authored = AuthoredStudy::from_scene(&scene).unwrap();
        let mut rerun = FmsRunIntent::new(
            "rerun",
            "rerun",
            json!({
                "parameters": {"live_workspace": {"step_id": "relax-a"}}
            }),
        );
        rerun.accepted_at = chrono::DateTime::from_timestamp(2, 0).unwrap();
        let intents = [rerun, run("whole", 1)];
        let mut reader = HistoryLineage::new(&store, &intents);
        let saved_b = stage_case("whole", "relax-b");
        let initial_state = StudyResultInitialState {
            source: predecessor("whole", "relax-b", "state-b", "digest-b"),
            reset_scopes: Vec::new(),
        };
        reader
            .cached
            .insert(saved_b.clone(), output("state-b", "digest-b", "recipe-b"));
        reader
            .cached
            .insert(key("whole"), output("state-a", "digest-a", "recipe-a"));
        reader.cached.insert(
            key("rerun"),
            output("new-state-a", "new-digest-a", "recipe-a"),
        );

        let b_input = (saved_b.clone(), "state-b".into(), "digest-b".into());
        let inherited_a = predecessor("whole", "relax-a", "state-a", "digest-a");
        reader
            .saved_inputs
            .insert(b_input.clone(), Some(inherited_a.clone()));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            EarlierPredecessorChanged
        );

        // The admitted source can remain available even for a legacy result
        // without the optional exact-input comparison fingerprint.
        reader.cached.insert(saved_b.clone(), Probe::Unavailable);
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            EarlierPredecessorChanged
        );
        reader
            .cached
            .insert(saved_b, output("state-b", "digest-b", "recipe-b"));

        reader.saved_inputs.insert(
            b_input.clone(),
            Some(StudyResultInitialStateSource::Authored {
                reference: "reset".into(),
            }),
        );
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NoLaterMatchingInput
        );

        let mut selected_a = inherited_a;
        let StudyResultInitialStateSource::StageResult { selection, .. } = &mut selected_a else {
            unreachable!()
        };
        *selection = StudyResultInputSelection::SelectedResult;
        reader
            .saved_inputs
            .insert(b_input.clone(), Some(selected_a));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NoLaterMatchingInput
        );

        reader
            .saved_inputs
            .insert(b_input.clone(), Some(initial_state.source.clone()));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            Unavailable
        );
        reader.saved_inputs.insert(b_input, None);
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            Unavailable
        );
    }

    #[test]
    fn predecessor_comparison_requires_the_consumed_pin_and_the_same_admitted_recipe() {
        use StudyResultPredecessorRelation::*;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let mut scene = SceneDocument::default();
        scene.study.stages = serde_json::from_value(json!([
            {"kind": "relax", "entrypoint_kind": "test", "stage_id": "relax-a"}
        ]))
        .unwrap();
        let authored = AuthoredStudy::from_scene(&scene).unwrap();
        let intents = [run("latest", 3), run("rerun", 2), run("original", 1)];
        let mut reader = HistoryLineage::new(&store, &intents);
        let root_key = (key("original"), "old-state".into(), "old-digest".into());
        let authored_source = Some(StudyResultInitialStateSource::Authored {
            reference: "m0".into(),
        });
        reader
            .saved_inputs
            .insert(root_key.clone(), authored_source.clone());
        let mut initial_state = StudyResultInitialState {
            source: StudyResultInitialStateSource::StageResult {
                run_id: "original".into(),
                step_id: "relax-a".into(),
                case_id: "default".into(),
                artifact_id: "old-state".into(),
                content_sha256: "old-digest".into(),
                selection: StudyResultInputSelection::Predecessor,
            },
            reset_scopes: Vec::new(),
        };
        reader
            .cached
            .insert(key("original"), output("old-state", "old-digest", "recipe"));
        reader.cached.insert(
            key("latest"),
            output("other-state", "other-digest", "other-recipe"),
        );
        reader
            .cached
            .insert(key("rerun"), output("new-state", "new-digest", "recipe"));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NewerDifferentOutput
        );

        reader
            .cached
            .insert(key("rerun"), output("new-state", "old-digest", "recipe"));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NewerSameOutput
        );
        reader.saved_inputs.insert(root_key.clone(), None);
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            Unavailable
        );
        reader.saved_inputs.insert(root_key, authored_source);

        let Probe::Saved(mut different_layout) = output("other-layout", "another-digest", "recipe")
        else {
            unreachable!()
        };
        different_layout.layout_sha256 = "different-layout".into();
        reader
            .cached
            .insert(key("rerun"), Probe::Saved(different_layout));
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NoLaterMatchingInput
        );

        reader.cached.insert(key("latest"), Probe::Unavailable);
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            Unavailable
        );

        reader.cached.insert(
            key("original"),
            output("wrong-state", "old-digest", "recipe"),
        );
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            Unavailable
        );

        let StudyResultInitialStateSource::StageResult { selection, .. } =
            &mut initial_state.source
        else {
            panic!("expected a state result")
        };
        *selection = StudyResultInputSelection::SelectedResult;
        assert_eq!(
            reader.predecessor_relation(&authored, &initial_state),
            NotApplicable
        );
    }
}
