"""Typed antenna declarations kept outside active execution state."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from fullmag.model.antenna import (
    AntennaFieldSolveStage,
    AntennaFieldSolutionRef,
    AntennaStageOutputRef,
    AntennaSpectrumRequest,
    AntennaTargetProjection,
    SolvedAntennaDrive,
)

if TYPE_CHECKING:
    from fullmag.model.problem import Problem


@dataclass(frozen=True, slots=True)
class AntennaAuthoringInventory:
    antenna_field_solve_stages: tuple[AntennaFieldSolveStage, ...] = ()
    antenna_target_projections: tuple[AntennaTargetProjection, ...] = ()
    solved_antenna_drives: tuple[SolvedAntennaDrive, ...] = ()
    antenna_spectrum_requests: tuple[AntennaSpectrumRequest, ...] = ()

    def to_ir(self) -> dict[str, list[dict[str, object]]]:
        """Serialize declarations separately from active ProblemIR collections."""
        return {
            collection: [item.to_ir() for item in getattr(self, collection)]
            for collection in self.__dataclass_fields__
        }

    def declare(self, collection: str, value: object) -> AntennaAuthoringInventory:
        expected = {
            "antenna_field_solve_stages": AntennaFieldSolveStage,
            "antenna_target_projections": AntennaTargetProjection,
            "solved_antenna_drives": SolvedAntennaDrive,
            "antenna_spectrum_requests": AntennaSpectrumRequest,
        }[collection]
        if not isinstance(value, expected):
            raise TypeError(f"{collection} declaration requires {expected.__name__}")
        entries = getattr(self, collection)
        if any(item.id == value.id for item in entries):
            raise ValueError(f"duplicate {collection} declaration id {value.id!r}")
        return replace(self, **{collection: (*entries, value)})

    def merge_into(self, problem: Problem) -> Problem:
        existing = AntennaAuthoringInventory(**{
            collection: tuple(getattr(problem, collection))
            for collection in self.__dataclass_fields__
        })
        merged = self.merge_with(existing)
        return replace(problem, **{
            collection: getattr(merged, collection)
            for collection in self.__dataclass_fields__
        })

    def merge_with(self, existing: AntennaAuthoringInventory) -> AntennaAuthoringInventory:
        """Validate declaration references without constructing an executable Problem."""
        updates = {}
        for collection in self.__dataclass_fields__:
            entries = list(getattr(existing, collection))
            by_id = {item.id: item for item in entries}
            for item in getattr(self, collection):
                existing_item = by_id.get(item.id)
                if existing_item is not None and existing_item != item:
                    raise ValueError(f"conflicting {collection} declaration id {item.id!r}")
                if existing_item is None:
                    entries.append(item)
                    by_id[item.id] = item
            updates[collection] = tuple(entries)
        merged = replace(existing, **updates)
        solves = {item.id: item for item in merged.antenna_field_solve_stages}
        projections = {item.id: item for item in merged.antenna_target_projections}

        def referenced_solve(
            solution: AntennaStageOutputRef | AntennaFieldSolutionRef,
        ) -> AntennaFieldSolveStage:
            solve = solves.get(solution.stage_id)
            if solve is None or not any(
                output.id == solution.output_id and output.quantity == "H_ant_basis"
                for output in solve.outputs
            ):
                raise ValueError("antenna declaration must reference an H_ant_basis solve output")
            return solve

        for definition in self.antenna_field_solve_stages:
            if sum(output.quantity == "H_ant_basis" for output in definition.outputs) != 1:
                raise ValueError("antenna solve declaration requires exactly one H_ant_basis output")
        for projection in self.antenna_target_projections:
            referenced_solve(projection.solution)
        for drive in self.solved_antenna_drives:
            projection = projections.get(drive.projection_ref)
            if projection is None:
                raise ValueError("antenna drive declaration references an unknown projection")
            solve = referenced_solve(projection.solution)
            if drive.port_mode_id not in solve.port_mode_ids:
                raise ValueError("antenna drive declaration port_mode_id is not in its solve")
        for request in self.antenna_spectrum_requests:
            solve = referenced_solve(request.solution_ref)
            if request.port_mode_id is not None and request.port_mode_id not in solve.port_mode_ids:
                raise ValueError("antenna spectrum declaration port_mode_id is not in its solve")
            if any(item.id != request.id and item.output_id == request.output_id
                   for item in merged.antenna_spectrum_requests):
                raise ValueError("duplicate antenna spectrum declaration output_id")
        return merged

    def execution_base(self, problem: Problem) -> Problem:
        return replace(problem, **{
            collection: tuple(
                item for item in getattr(problem, collection)
                if item.id not in {entry.id for entry in getattr(self, collection)}
            )
            for collection in self.__dataclass_fields__
        })
