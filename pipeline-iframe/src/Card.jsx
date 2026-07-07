import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export default function Card({ card, onClick }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, data: card });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const formattedDate = new Date(card.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onClick(card)}
      className={`bg-white rounded-lg shadow-sm border border-gray-200 p-3 mb-3 cursor-grab active:cursor-grabbing hover:border-gray-300 transition-colors ${
        isDragging ? 'opacity-50 ring-2 ring-blue-500' : ''
      }`}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="font-medium text-gray-900 text-sm truncate pr-2">
          {card.contact?.name || card.name}
        </div>
        {card.monetaryValue > 0 && (
          <div className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full shrink-0">
            ${card.monetaryValue.toLocaleString()}
          </div>
        )}
      </div>
      
      {card.notes && (
        <div className="text-xs text-gray-500 line-clamp-1 mb-2 italic">
          {card.notes}
        </div>
      )}
      
      <div className="flex justify-between items-center text-xs text-gray-400 mt-2">
        <span>Updated {formattedDate}</span>
      </div>
    </div>
  );
}
