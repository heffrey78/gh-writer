import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type ColorMode, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

export interface GraphNode {
  id: string;
  label: string;
  /** The entity type's label, shown under the name. */
  type: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  /** A colour token name (accent, warn, ok, danger, ink, muted); muted when unset. */
  tone?: string;
  line?: "solid" | "dashed" | "dotted";
  /** Symmetric relationships have no arrow. */
  directed?: boolean;
  /** What a screen reader says for it, e.g. "Ada Varn, Allied with, Ben Varn". */
  ariaLabel?: string;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The canvas's accessible name. */
  label: string;
  /** Nodes moved by dragging or with the arrow keys, once they settle. */
  onNodesMoved?: (positions: Record<string, { x: number; y: number }>) => void;
  /** Light, dark, or the system's. */
  colorMode?: ColorMode;
  /** The selected node: its relationships stand out, the rest are dimmed. */
  selected?: string | undefined;
  /** The author selected a node (click, or Enter on a focused one), or cleared the selection. */
  onSelect?: (id: string | undefined) => void;
}

type EntityData = { label: string; type: string };

/** One entity: its name and type. Memoised, so dragging one node re-renders only that node. */
const EntityNode = memo(function EntityNode({ data }: NodeProps<Node<EntityData>>) {
  return (
    <div className="grid min-w-28 rounded-lg border border-rule bg-raised px-3 py-1.5 text-center text-sm text-ink shadow-sm">
      <Handle type="target" position={Position.Top} className="!bg-muted" />
      <span className="font-medium">{data.label}</span>
      <span className="text-xs text-muted">{data.type}</span>
      <Handle type="source" position={Position.Bottom} className="!bg-muted" />
    </div>
  );
});

const nodeTypes = { entity: EntityNode };
const DASH = { solid: undefined, dashed: "6 4", dotted: "2 4" } as const;

/** Entities as nodes and relationships as labelled edges, on a pannable, zoomable canvas. */
export function GraphCanvas({ nodes, edges, label, onNodesMoved, colorMode = "system", selected, onSelect }: GraphCanvasProps) {
  const initial = useMemo(() => nodes.map(toFlowNode), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(initial);

  // New or changed entities from outside; positions being dragged stay as they are.
  useEffect(() => {
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const was = byId.get(n.id);
        return was && was.data.label === n.label && was.data.type === n.type ? was : { ...toFlowNode(n), position: was?.position ?? { x: n.x, y: n.y } };
      });
    });
  }, [nodes, setFlowNodes]);

  // With a node selected: it and its neighbours at full strength, everything else faint.
  const near = useMemo(() => {
    if (!selected) return undefined;
    const out = new Set([selected]);
    for (const e of edges) if (e.source === selected || e.target === selected) out.add(e.source).add(e.target);
    return out;
  }, [edges, selected]);
  const shownNodes = useMemo(
    () => flowNodes.map((n) => ({ ...n, selected: n.id === selected, className: near && !near.has(n.id) ? "opacity-30" : "" })),
    [flowNodes, near, selected],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const colour = `var(--ghw-${e.tone ?? "muted"})`;
        const faint = selected && e.source !== selected && e.target !== selected;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          style: { stroke: colour, strokeWidth: selected && !faint ? 2.5 : 1.5, strokeDasharray: DASH[e.line ?? "solid"] },
          className: faint ? "opacity-20" : "",
          labelStyle: { fill: "var(--ghw-ink)", fontSize: 12 },
          labelBgStyle: { fill: "var(--ghw-paper)" },
          ...(e.directed ? { markerEnd: { type: MarkerType.ArrowClosed, color: colour } } : {}),
          ...(e.ariaLabel ? { ariaLabel: e.ariaLabel } : {}),
        };
      }),
    [edges, selected],
  );

  // Moves are reported once they settle: a drag when it ends, arrow-key steps after a pause.
  const moved = useRef<Record<string, { x: number; y: number }>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(onNodesMoved);
  latest.current = onNodesMoved;
  const choose = useRef(onSelect);
  choose.current = onSelect;
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChange = useCallback(
    (changes: NodeChange<Node<EntityData>>[]) => {
      onNodesChange(changes);
      // A node selected by click or by Enter on it (React Flow reports both as a change).
      const picked = changes.find((c) => c.type === "select" && c.selected);
      if (picked && "id" in picked) choose.current?.(picked.id);
      let any = false;
      for (const c of changes) {
        if (c.type === "position" && c.position && !c.dragging) {
          moved.current[c.id] = { x: c.position.x, y: c.position.y };
          any = true;
        }
      }
      if (!any) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const positions = moved.current;
        moved.current = {};
        if (Object.keys(positions).length) latest.current?.(positions);
      }, 400);
    },
    [onNodesChange],
  );

  return (
    <div className="h-full min-h-96 w-full" role="region" aria-label={label}>
      <ReactFlow
        nodes={shownNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onChange}
        onPaneClick={() => onSelect?.(undefined)}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        colorMode={colorMode}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function toFlowNode(n: GraphNode): Node<EntityData> {
  return { id: n.id, type: "entity", position: { x: n.x, y: n.y }, data: { label: n.label, type: n.type }, ariaLabel: `${n.label}, ${n.type}` };
}
