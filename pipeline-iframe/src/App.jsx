import React, { useState, useEffect, useRef } from 'react';
import Board from './Board';
import { fetchBoard } from './api';

export default function App() {
  const [boardData, setBoardData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef(null);

  const loadBoard = async () => {
    try {
      const data = await fetchBoard();
      setBoardData(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBoard();

    const startPolling = () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(() => {
        if (!document.hidden) {
          loadBoard();
        }
      }, 60000); // 60s
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        loadBoard();
        startPolling();
      } else {
        if (pollingRef.current) clearInterval(pollingRef.current);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    startPolling();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error === "PIPELINE_NOT_CONFIGURED") {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-gray-50 text-center px-4">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 max-w-md">
          <h2 className="text-xl font-bold text-gray-900 mb-2">Almost Ready!</h2>
          <p className="text-gray-500">Your board is being set up in the background. Please check back shortly.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 text-center px-4">
        <div className="bg-red-50 text-red-600 p-4 rounded-lg max-w-md border border-red-100">
          <p className="font-semibold">Failed to load board</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const { summary, columns } = boardData;

  return (
    <div className="flex flex-col h-screen bg-gray-50/50 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shadow-sm z-10">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Reactivation Results</h1>
          <div className="text-sm text-gray-500 mt-0.5 flex gap-2 items-center">
            <span>{summary.recoveredCount} jobs recovered</span>
            <span className="text-gray-300">&bull;</span>
            <span>{summary.bookedCount} booked</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium text-emerald-700 uppercase tracking-wide">Revenue Recovered</div>
          <div className="text-3xl font-bold text-emerald-600">
            ${summary.recoveredTotal.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-hidden relative">
        <Board 
          columns={columns} 
          setColumns={(newCols) => setBoardData({ ...boardData, columns: newCols })} 
          refreshBoard={loadBoard} 
        />
      </div>
    </div>
  );
}
