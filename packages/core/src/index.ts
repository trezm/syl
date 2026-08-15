// Annotations
export type {
  Annotation,
  AnnotationFile,
  SylConfig,
  SemanticNode,
  ResolvedAnnotation,
} from "./annotations/types.js";
export { AnnotationStore } from "./annotations/store.js";
export type { FileSystem } from "./annotations/store.js";

// Tree-sitter
export type { LanguagePathConfig } from "./tree-sitter/language-config.js";
export {
  registerLanguage,
  getLanguageForFile,
  getAllLanguages,
} from "./tree-sitter/language-config.js";
export { buildSemanticPaths } from "./tree-sitter/semantic-path.js";
export type { SemanticPathResult } from "./tree-sitter/semantic-path.js";
export { initTreeSitter, createParser, Parser } from "./tree-sitter/init.js";

// Language registrations (side effects)
import "./tree-sitter/languages/typescript.js";
import "./tree-sitter/languages/javascript.js";
import "./tree-sitter/languages/python.js";
import "./tree-sitter/languages/rust.js";
import "./tree-sitter/languages/go.js";
import "./tree-sitter/languages/swift.js";
import "./tree-sitter/languages/kotlin.js";

// Models
export type { ModelProvider, ModelInfo } from "./models.js";
export {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  DEFAULT_MODELS,
  DEFAULT_MODEL_ID,
  PROVIDER_LABELS,
  PROVIDER_AUTHORS,
  PROVIDER_ENV_KEYS,
  findModel,
} from "./models.js";

// Projects
export type { ProjectSummary } from "./projects.js";

// Fuzzy matching
export type { FuzzyMatch, FuzzyResult } from "./fuzzy.js";
export { fuzzyMatch, fuzzyFilter } from "./fuzzy.js";

// Links
export type { LinkTarget, ParsedRef, BodySegment } from "./links.js";
export {
  parseRef,
  parseAnnotationBody,
  collectRefs,
  looksLikeFile,
} from "./links.js";

// Diff
export type {
  DiffLine,
  DiffLineType,
  DiffHunk,
  DiffFile,
  DiffFileStatus,
  DiffSplitRow,
  DiffGap,
} from "./diff.js";
export {
  parseUnifiedDiff,
  diffTotals,
  toSplitRows,
  diffGaps,
  gapContextLines,
} from "./diff.js";

// Review
export type {
  FindingSeverity,
  FindingCategory,
  RiskLevel,
  ScoutFocusArea,
  ScoutResult,
  Finding,
  ReviewResult,
  GitRemote,
  PullRequestSummary,
  PullRequestInvolvement,
  PullRequestStateFilter,
  PullRequestFilter,
  PullRequestMeta,
  ReviewPhase,
  ReviewRun,
  ReviewRunSummary,
  ReviewReuse,
  ReviewCommentSide,
  ReviewEvent,
  DraftComment,
  SubmittedReview,
} from "./review.js";
export {
  PULL_REQUEST_INVOLVEMENTS,
  PULL_REQUEST_STATE_FILTERS,
  DEFAULT_PULL_REQUEST_FILTER,
  parsePullRequestFilter,
  pullRequestFilterQuery,
  SEVERITY_ORDER,
  severityRank,
  sortFindings,
  summarizeRun,
  isReviewStale,
  outdatedComments,
  REVIEW_EVENTS,
  findingToCommentBody,
  commentTargetKey,
  diffCommentTargets,
  canCommentOn,
  anchorForFinding,
} from "./review.js";

// Resolver
export { resolveAnnotations } from "./annotations/resolver.js";
export { detectOrphans } from "./orphans/detector.js";
