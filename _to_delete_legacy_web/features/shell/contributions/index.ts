/**
 * Auto-register all ribbon contributions.
 *
 * Import this module once (e.g. in RibbonBar or the app root) to
 * ensure every contribution is registered before the first render.
 * Each file's top-level `registerRibbonContribution()` call runs
 * as a side-effect of the import.
 */

import "./home";
import "./view";
import "./definitions";
import "./geometry-builder";
import "./materials";
import "./physics";
import "./mesh";
import "./study";
import "./results";
import "./automation";
import "./contextual";
import "@/features/plots2d/contributions/plots2dRibbon";
