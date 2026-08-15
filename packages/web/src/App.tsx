import { useState, useCallback, useEffect, useMemo } from "react";
import { collectRefs } from "@syl/core";
import type { Annotation, SemanticNode, LinkTarget } from "@syl/core";
import type { EditorView } from "@codemirror/view";
import FileBrowser from "./components/FileBrowser";
import FileFinder from "./components/FileFinder";
import CodeViewer from "./components/CodeViewer";
import AnnotationOverlay, {
  AnnotationBracket,
} from "./components/AnnotationOverlay";
import ModelSelector, {
  useSelectedModel,
  type AvailableModel,
} from "./components/ModelSelector";
import GenerateButton from "./components/GenerateButton";
import { useTreeSitter } from "./hooks/useTreeSitter";
import ReviewView from "./review/ReviewView";
import ProjectSwitcher from "./projects/ProjectSwitcher";
import type { ResolvedLinks } from "./components/AnnotationBody";
import {
  fetchFileContent,
  fetchFileTree,
  resolveAnnotations,
  generateAnnotation,
  generateFileAnnotations,
  checkGenerateStatus,
  resolveLinks,
  ResolveResponse,
  type FileNode,
} from "./api";

/** Depth-first list of every file path in the tree, for the Cmd+K finder. */
function flattenFiles(nodes: FileNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "directory") flattenFiles(node.children ?? [], into);
    else into.push(node.path);
  }
  return into;
}

function buildBrackets(
  nodes: SemanticNode[],
  annotations: Record<string, Annotation[]>,
  depth: number
): AnnotationBracket[] {
  const result: AnnotationBracket[] = [];
  for (const node of nodes) {
    const anns = annotations[node.path];
    if (anns && anns.length > 0) {
      result.push({
        path: node.path,
        startLine: node.startLine,
        endLine: node.endLine,
        column: depth,
        body: anns[0].body,
        count: anns.length,
        annotations: anns,
      });
    }
    result.push(...buildBrackets(node.children, annotations, depth + 1));
  }
  return result;
}

type Mode = "annotate" | "review";

export default function App() {
  const [mode, setMode] = useState<Mode>("annotate");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  /** Which file `fileContent` actually belongs to — lags selectedFile while loading. */
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [resolvedData, setResolvedData] = useState<ResolveResponse | null>(
    null
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [links, setLinks] = useState<ResolvedLinks>({});
  const [pendingTarget, setPendingTarget] = useState<LinkTarget | null>(null);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(
    null
  );
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [finderOpen, setFinderOpen] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const { model, selectModel } = useSelectedModel(models, defaultModel);

  const { pathResult } = useTreeSitter(selectedFile, fileContent);

  useEffect(() => {
    fetchFileTree()
      .then(setTree)
      .catch(() => {})
      .finally(() => setTreeLoading(false));
  }, []);

  const allFiles = useMemo(() => flattenFiles(tree), [tree]);

  // Cmd/Ctrl+K opens the finder from anywhere, including the review tab.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setFinderOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Which models the server can actually run (i.e. whose API key is set)
  useEffect(() => {
    checkGenerateStatus()
      .then((s) => {
        setModels(s.models ?? []);
        setDefaultModel(s.defaultModel ?? null);
      })
      .catch(() => {});
  }, []);

  const generateAvailable = model !== null;

  useEffect(() => {
    if (!selectedFile) {
      setFileContent(null);
      setLoadedFile(null);
      setSelectedPath(null);
      setResolvedData(null);
      return;
    }
    let cancelled = false;
    fetchFileContent(selectedFile).then((data) => {
      if (cancelled) return;
      setFileContent(data.content);
      setLoadedFile(selectedFile);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  useEffect(() => {
    if (!selectedFile) return;
    let cancelled = false;
    resolveAnnotations(selectedFile).then((data) => {
      if (!cancelled) setResolvedData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, refreshKey]);

  // Resolve every ref in this file's annotations in one round trip
  useEffect(() => {
    if (!selectedFile || !resolvedData) {
      setLinks({});
      return;
    }
    const refs = new Set<string>();
    for (const annotations of Object.values(resolvedData.annotations)) {
      for (const annotation of annotations) {
        for (const ref of collectRefs(annotation.body)) refs.add(ref);
      }
    }
    if (refs.size === 0) {
      setLinks({});
      return;
    }
    let cancelled = false;
    resolveLinks(selectedFile, [...refs])
      .then((resolved) => {
        if (!cancelled) setLinks(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedFile, resolvedData]);

  // A link may point at another file. Wait for that file's content to be the
  // content actually on screen, otherwise the line would be revealed against
  // the outgoing file.
  useEffect(() => {
    if (!pendingTarget || loadedFile !== pendingTarget.file) return;
    setSelectedPath(pendingTarget.kind === "line" ? null : pendingTarget.path);
    setReveal({ line: pendingTarget.startLine, nonce: Date.now() });
    setPendingTarget(null);
  }, [pendingTarget, loadedFile]);

  const handleNavigate = useCallback((target: LinkTarget) => {
    setSelectedFile(target.file);
    setPendingTarget(target);
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    setSelectedFile(path);
    setSelectedPath(null);
    setReveal(null);
  }, []);

  const handleSelectPath = useCallback((path: string | null) => {
    setSelectedPath(path);
  }, []);

  const handleAnnotationsChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleGenerate = useCallback(
    async (semanticPath: string) => {
      if (!selectedFile || !model) return;
      await generateAnnotation(selectedFile, model, semanticPath);
    },
    [selectedFile, model]
  );

  const handleGenerateFile = useCallback(async () => {
    if (!selectedFile || !model) return;
    await generateFileAnnotations(selectedFile, model);
    handleAnnotationsChanged();
  }, [selectedFile, model, handleAnnotationsChanged]);

  const annotatedPaths = new Set(
    resolvedData ? Object.keys(resolvedData.annotations) : []
  );

  const annotationBrackets = useMemo(() => {
    if (!pathResult || !resolvedData) return [];
    const brackets = buildBrackets(pathResult.roots, resolvedData.annotations, 0);

    // If a node is selected but has no annotations yet, inject a temporary
    // bracket so the user can still "+ Add" or "AI Generate" on it.
    if (
      selectedPath &&
      !brackets.some((b) => b.path === selectedPath)
    ) {
      const node = pathResult.pathMap.get(selectedPath);
      if (node) {
        // Determine depth by counting dots in the path
        const depth = selectedPath.split(".").length - 1;
        brackets.push({
          path: node.path,
          startLine: node.startLine,
          endLine: node.endLine,
          column: depth,
          body: "",
          count: 0,
          annotations: [],
        });
      }
    }

    return brackets;
  }, [pathResult, resolvedData, selectedPath]);

  const totalLines = fileContent ? fileContent.split("\n").length : 0;

  const showOverlay = selectedFile && annotationBrackets.length > 0;

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      <header className="flex items-center px-4 py-2 border-b border-gray-800 bg-gray-950">
        <h1 className="text-sm font-semibold tracking-wide text-gray-300">
          syl
        </h1>
        <div className="ml-3">
          <ProjectSwitcher />
        </div>
        <nav className="ml-4 flex items-center gap-1">
          {(["annotate", "review"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`text-xs px-2 py-1 rounded capitalize ${
                mode === m
                  ? "bg-gray-800 text-gray-100"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {m}
            </button>
          ))}
        </nav>
        {mode === "annotate" && selectedFile && (
          <span className="ml-3 text-xs text-gray-500 font-mono">
            {selectedFile}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {mode === "annotate" && generateAvailable && (
            <>
              <ModelSelector
                models={models}
                model={model}
                onSelect={selectModel}
              />
              {selectedFile && pathResult && pathResult.roots.length > 0 && (
                <GenerateButton
                  label="Generate File"
                  onClick={handleGenerateFile}
                  size="md"
                />
              )}
            </>
          )}
        </div>
      </header>
      {mode === "review" && (
        <ReviewView
          onNavigate={(target) => {
            setMode("annotate");
            handleNavigate(target);
          }}
        />
      )}
      <div
        className="flex flex-1 overflow-hidden"
        style={{ display: mode === "annotate" ? undefined : "none" }}
      >
        <div className="w-56 flex-shrink-0">
          <FileBrowser
            onSelect={handleFileSelect}
            selectedFile={selectedFile}
            tree={tree}
            loading={treeLoading}
          />
        </div>
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 overflow-hidden">
            {fileContent !== null && selectedFile ? (
              <CodeViewer
                content={fileContent}
                filePath={selectedFile}
                pathResult={pathResult}
                annotatedPaths={annotatedPaths}
                selectedPath={selectedPath}
                onSelectPath={handleSelectPath}
                onViewReady={setEditorView}
                reveal={reveal}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-600">
                Select a file to view
              </div>
            )}
          </div>
          {showOverlay && (
            <AnnotationOverlay
              editorView={editorView}
              annotations={annotationBrackets}
              totalLines={totalLines}
              filePath={selectedFile!}
              onSelectPath={handleSelectPath}
              selectedPath={selectedPath}
              onAnnotationsChanged={handleAnnotationsChanged}
              onGenerate={generateAvailable ? handleGenerate : undefined}
              links={links}
              onNavigate={handleNavigate}
            />
          )}
        </div>
      </div>

      <FileFinder
        open={finderOpen}
        files={allFiles}
        onClose={() => setFinderOpen(false)}
        onSelect={(path) => {
          // Opening a file only means something on the annotate tab, so jump
          // there — the same move the review tab's annotation links make.
          setMode("annotate");
          handleFileSelect(path);
        }}
      />
    </div>
  );
}
