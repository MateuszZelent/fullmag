import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";
import { type DraggableAttributes, type UniqueIdentifier } from "@dnd-kit/core";

type SortableListeners = ReturnType<typeof useSortable>["listeners"];

interface SortableItemRenderProps {
  attributes: DraggableAttributes;
  isDragging: boolean;
  listeners: SortableListeners;
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
}

interface SortableItemProps {
  children: (props: SortableItemRenderProps) => ReactNode;
  id: UniqueIdentifier;
}

export function SortableItem({ children, id }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return children({
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
    },
  });
}
