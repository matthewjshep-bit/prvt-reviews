import React, { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import Column from './Column';
import Drawer from './Drawer';
import { updateOpportunity } from './api';

export default function Board({ columns, setColumns, refreshBoard, createIntent, clearCreateIntent }) {
  const [activeCard, setActiveCard] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  React.useEffect(() => {
    if (createIntent) {
      setActiveCard({ stageId: columns[0]?.stageId || '' });
      setDrawerOpen(true);
      clearCreateIntent();
    }
  }, [createIntent, columns, clearCreateIntent]);

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over) return;

    const cardId = active.id;
    const destStageId = over.id; // column id is stageId

    // Find source column and card
    let sourceColIndex = -1;
    let cardIndex = -1;
    let card = null;

    for (let i = 0; i < columns.length; i++) {
      const idx = columns[i].cards.findIndex(c => c.id === cardId);
      if (idx !== -1) {
        sourceColIndex = i;
        cardIndex = idx;
        card = columns[i].cards[idx];
        break;
      }
    }

    if (!card || columns[sourceColIndex].stageId === destStageId) return;

    const destColIndex = columns.findIndex(c => c.stageId === destStageId);
    if (destColIndex === -1) return;

    const destStageName = columns[destColIndex].stageName;

    // Check if moving to Recovered with 0 value
    if (destStageName === "Recovered" && (!card.monetaryValue || card.monetaryValue === 0)) {
      // Open drawer to force them to add a value
      setActiveCard({ ...card, stageId: destStageId }); // Pre-fill new stage
      setDrawerOpen(true);
      return;
    }

    // Optimistic UI Update
    const newColumns = [...columns];
    // Remove from source
    newColumns[sourceColIndex] = {
      ...newColumns[sourceColIndex],
      cards: newColumns[sourceColIndex].cards.filter(c => c.id !== cardId),
      total: newColumns[sourceColIndex].total - 1
    };
    // Add to dest
    newColumns[destColIndex] = {
      ...newColumns[destColIndex],
      cards: [card, ...newColumns[destColIndex].cards],
      total: newColumns[destColIndex].total + 1
    };
    
    setColumns(newColumns);

    try {
      await updateOpportunity(card.id, { stageId: destStageId });
      refreshBoard(); // Pull true state from server (rollup updates etc)
    } catch (err) {
      alert("Failed to move card. Try again.");
      refreshBoard(); // Revert to true server state
    }
  };

  const handleCardClick = (card) => {
    // Find the current stage of the card
    const col = columns.find(c => c.cards.some(cc => cc.id === card.id));
    setActiveCard({ ...card, stageId: col?.stageId });
    setDrawerOpen(true);
  };

  const handleDrawerSave = (updatedCard, newStageId) => {
    refreshBoard();
  };

  const stagesOptions = columns.map(c => ({ stageId: c.stageId, stageName: c.stageName }));

  return (
    <>
      <DndContext 
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 h-full p-6 overflow-x-auto items-start">
          {columns.map(column => (
            <Column 
              key={column.stageId} 
              column={column} 
              onCardClick={handleCardClick} 
            />
          ))}
        </div>
      </DndContext>

      <Drawer 
        open={drawerOpen} 
        onClose={() => setDrawerOpen(false)} 
        card={activeCard}
        stages={stagesOptions}
        onSave={handleDrawerSave}
      />
    </>
  );
}
