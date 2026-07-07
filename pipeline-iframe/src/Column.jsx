import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import Card from './Card';

const STAGE_DISPLAY = {
  "Woke Up":  { label: "Woke Up",   color: "bg-amber-100 text-amber-800 border-amber-200" },
  "Talking":  { label: "Talking",   color: "bg-blue-100 text-blue-800 border-blue-200" },
  "Booked":   { label: "Booked",    color: "bg-violet-100 text-violet-800 border-violet-200" },
  "Recovered":{ label: "Recovered", color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
};

export default function Column({ column, onCardClick }) {
  const { setNodeRef } = useDroppable({
    id: column.stageId,
  });

  const display = STAGE_DISPLAY[column.stageName] || { label: column.stageName, color: "bg-gray-100 text-gray-800 border-gray-200" };

  return (
    <div className="flex flex-col w-80 shrink-0 bg-gray-50/50 rounded-xl border border-gray-200 h-full overflow-hidden">
      <div className="p-3 border-b border-gray-200 bg-gray-50/80 backdrop-blur-sm sticky top-0 z-10 flex justify-between items-center">
        <div className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${display.color}`}>
          {display.label}
        </div>
        <div className="text-xs font-medium text-gray-500 bg-white px-2 py-0.5 rounded-full shadow-sm border border-gray-100">
          {column.total}
        </div>
      </div>
      
      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-3 min-h-[150px]">
        <SortableContext
          items={column.cards.map(c => c.id)}
          strategy={verticalListSortingStrategy}
        >
          {column.cards.length > 0 ? (
            column.cards.map(card => (
              <Card key={card.id} card={card} onClick={onCardClick} />
            ))
          ) : (
            <div className="h-full flex items-center justify-center text-center p-4">
              <p className="text-sm text-gray-400 italic">
                {column.stageName === "Woke Up" ? "Reactivated contacts land here automatically" : "Drop cards here"}
              </p>
            </div>
          )}
        </SortableContext>
      </div>
    </div>
  );
}
