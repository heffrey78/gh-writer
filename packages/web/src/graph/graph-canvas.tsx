import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo } from "react";

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
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The canvas's accessible name. */
  label: string;
  /** A node was dragged to a new place. */
  onNodeMoved?: (id: string, x: number, y: number) => void;
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
export function GraphCanvas({ nodes, edges, label, onNodeMoved }: GraphCanvasProps) {
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

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        const colour = `var(--ghw-${e.tone ?? "muted"})`;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          style: { stroke: colour, strokeWidth: 1.5, strokeDasharray: DASH[e.line ?? "solid"] },
          labelStyle: { fill: "var(--ghw-ink)", fontSize: 12 },
          labelBgStyle: { fill: "var(--ghw-paper)" },
          ...(e.directed ? { markerEnd: { type: MarkerType.ArrowClosed, color: colour } } : {}),
        };
      }),
    [edges],
  );

  return (
    <div className="h-full min-h-96 w-full" role="region" aria-label={label}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => onNodeMoved?.(node.id, node.position.x, node.position.y)}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        colorMode="system"
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function toFlowNode(n: GraphNode): Node<EntityData> {
  return { id: n.id, type: "entity", position: { x: n.x, y: n.y }, data: { label: n.label, type: n.type } };
}
