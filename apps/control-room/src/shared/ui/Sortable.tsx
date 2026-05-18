"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";

type SortableListeners = ReturnType<typeof useSortable>["listeners"];

interface SortableItemRenderProps {
  attributes: DraggableAttributes;
  isDragging: boolean;
  listeners: SortableListeners;
  setNodeRef: (element: HTMLElement | null) => void;
  style: CSSProperties;
}

interface SortableListProps {
  children: ReactNode;
  id: string;
  items: UniqueIdentifier[];
  onMove: (activeId: string, overId: string) => void;
}

interface SortableItemProps {
  children: (props: SortableItemRenderProps) => ReactNode;
  id: UniqueIdentifier;
}

export function SortableList({
  children,
  id,
  items,
  onMove,
}: SortableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;

    if (!over) {
      return;
    }

    onMove(String(active.id), String(over.id));
  }

  return (
    <DndContext
      collisionDetection={closestCenter}
      id={id}
      onDragEnd={handleDragEnd}
      sensors={sensors}
    >
      <SortableContext items={items} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
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
