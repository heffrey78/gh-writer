import { Background, BaseEdge, ConnectionMode, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type ColorMode, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
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
  /** A line was drawn from one node to another: a new relationship. */
  onConnect?: (from: string, to: string) => void;
  /** An edge was clicked, or Enter pressed on a focused one. */
  onEdgeOpen?: (id: string) => void;
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

/**
 * An edge that bows to one side by `offset` pixels, so several relationships between the same two
 * entities (siblings and rivals, say) are drawn apart, each with its own label, rather than on top
 * of each other. The side is fixed by the pair, not the direction, so a→b and b→a fan out together.
 */
function ParallelEdge({ sourceX, sourceY, targetX, targetY, source, target, data, label, style, markerEnd, labelStyle, labelBgStyle, interactionWidth }: EdgeProps<Edge<{ offset: number }>>) {
  const offset = data?.offset ?? 0;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const side = source < target ? 1 : -1;
  // The curve's peak is half the control point's distance from the line.
  const cx = (sourceX + targetX) / 2 + ((-dy / length) * offset * 2 * side);
  const cy = (sourceY + targetY) / 2 + ((dx / length) * offset * 2 * side);
  const labelX = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
  const labelY = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;
  return (
    <BaseEdge
      path={`M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelShowBg
      labelBgPadding={LABEL_PADDING}
      style={style}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
}

const nodeTypes = { entity: EntityNode };
const edgeTypes = { parallel: ParallelEdge };
const SPACING = 28;
// Constant: the label measures itself again whenever its padding changes.
const LABEL_PADDING: [number, number] = [4, 2];
const DASH = { solid: undefined, dashed: "6 4", dotted: "2 4" } as const;

/** Entities as nodes and relationships as labelled edges, on a pannable, zoomable canvas. */
export function GraphCanvas({ nodes, edges, label, onNodesMoved, colorMode = "system", selected, onSelect, onConnect, onEdgeOpen }: GraphCanvasProps) {
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

  // Relationships between the same two entities, spread around the straight line between them.
  const offsets = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const e of edges) {
      const key = [e.source, e.target].sort().join(" ");
      groups.set(key, [...(groups.get(key) ?? []), e.id]);
    }
    const out = new Map<string, number>();
    for (const ids of groups.values()) ids.forEach((id, i) => out.set(id, (i - (ids.length - 1) / 2) * SPACING));
    return out;
  }, [edges]);

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const colour = `var(--ghw-${e.tone ?? "muted"})`;
        const faint = selected && e.source !== selected && e.target !== selected;
        return {
          id: e.id,
          type: "parallel",
          data: { offset: offsets.get(e.id) ?? 0 },
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
    [edges, selected, offsets],
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

  const openEdge = useRef(onEdgeOpen);
  openEdge.current = onEdgeOpen;
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const picked = changes.find((c) => c.type === "select" && c.selected);
    if (picked && "id" in picked) openEdge.current?.(picked.id);
  }, []);

  return (
    <div className="h-full min-h-96 w-full" role="region" aria-label={label}>
      <ReactFlow
        nodes={shownNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onChange}
        onPaneClick={() => onSelect?.(undefined)}
        onEdgesChange={onEdgesChange}
        onEdgeClick={(_, edge) => onEdgeOpen?.(edge.id)}
        onConnect={(c) => c.source && c.target && c.source !== c.target && onConnect?.(c.source, c.target)}
        connectionMode={ConnectionMode.Loose}
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
