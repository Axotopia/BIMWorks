import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  ArrowRight,
  CheckCircle2,
  XCircle,
  History,
  RotateCcw,
  Layers,
  HelpCircle,
  ChevronUp,
  ChevronDown,
  Terminal,
} from 'lucide-react';
import { useBimStore } from '../../store/useBimStore';

export const PromptBar: React.FC = () => {
  const {
    isPromptBarOpen,
    setPromptBarOpen,
    aiPlanPreview,
    setAiPlanPreview,
    generateAiPlan,
    commitAiPlan,
    discardAiPlan,
    undoTransaction,
    transactionJournal,
    fetchTransactionJournal,
    statusMessage,
  } = useBimStore();

  const [promptText, setPromptText] = useState('');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkey: Ctrl+Enter or '/' focuses prompt bar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        setPromptBarOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setPromptBarOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setPromptBarOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptText.trim()) return;

    if (aiPlanPreview) {
      // If a preview is already staged, pressing Enter commits it
      await commitAiPlan();
      setPromptText('');
      return;
    }

    setIsSynthesizing(true);
    try {
      const plan = await generateAiPlan(promptText);
      if (plan) {
        setAiPlanPreview(plan);
      }
    } catch (err) {
      console.error('Failed to synthesize plan:', err);
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleKeyDownInput = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (aiPlanPreview) {
        discardAiPlan();
      } else {
        setPromptBarOpen(false);
      }
    }
  };

  const samplePrompts = [
    'Add 40x30 perimeter walls',
    'Insert 36"x84" door in wall',
    'Add 48"x48" window',
    'Construct 10" concrete slab',
    'Equalize window spacing',
  ];

  return (
    <div className="flex flex-col border-t border-[#333333] bg-[#1a1a1a] select-none text-[12px] z-30 transition-all">
      {/* Expandable Replay Journal & Transcript */}
      {showJournal && (
        <div className="border-b border-[#333333] bg-[#141414] px-4 py-2.5 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between pb-1.5 border-b border-[#2a2a2a] mb-2 text-[#999999] text-[11px]">
            <span className="flex items-center space-x-1.5 font-semibold text-[#38bdf8]">
              <Terminal className="w-3.5 h-3.5" />
              <span>CommandBus Replay Journal (Audit Trail)</span>
            </span>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => undoTransaction()}
                className="flex items-center space-x-1 text-[#e2e8f0] hover:text-white bg-[#262626] hover:bg-[#333333] px-2 py-0.5 rounded text-[10px]"
                title="Undo last transaction"
              >
                <RotateCcw className="w-3 h-3 text-[#f59e0b]" />
                <span>Undo Step</span>
              </button>
              <button
                onClick={() => setShowJournal(false)}
                className="text-[#777777] hover:text-white text-[11px]"
              >
                Close
              </button>
            </div>
          </div>

          {transactionJournal.length === 0 ? (
            <div className="text-[#666666] text-[11px] py-1 italic">No recorded transactions yet.</div>
          ) : (
            <div className="space-y-1">
              {transactionJournal.slice().reverse().map((tx) => (
                <div
                  key={tx.transaction_id}
                  className="flex items-center justify-between text-[11px] bg-[#1e1e1e] px-2.5 py-1 rounded border border-[#262626]"
                >
                  <div className="flex items-center space-x-2">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-bold ${
                        tx.origin === 'ai' ? 'bg-[#0369a1] text-[#e0f2fe]' : 'bg-[#334155] text-[#94a3b8]'
                      }`}
                    >
                      {tx.origin}
                    </span>
                    <span className="text-[#e2e8f0] font-medium">{tx.description}</span>
                    <span className="text-[#64748b] text-[10px]">({tx.commands.length} cmds)</span>
                  </div>
                  <span className="text-[#64748b] text-[10px] font-mono">{tx.transaction_id}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Interactive Plan Preview Banner (Spec §5.2) */}
      {aiPlanPreview && (
        <div className="bg-[#0c4a6e] border-b border-[#0284c7] px-4 py-2 flex items-center justify-between text-[#f0f9ff] animate-in fade-in duration-200">
          <div className="flex items-center space-x-2.5">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#0284c7] text-white">
              <Sparkles className="w-3 h-3" />
            </span>
            <div>
              <span className="font-semibold text-[12px] text-white">AI Plan Preview: </span>
              <span className="text-[#bae6fd] text-[12px]">{aiPlanPreview.intentSummary}</span>
              <span className="ml-2 text-[10px] bg-[#0369a1] px-1.5 py-0.5 rounded text-[#e0f2fe]">
                {aiPlanPreview.commands.length} typed commands &bull; 1 undo step
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => commitAiPlan()}
              className="flex items-center space-x-1.5 bg-[#0284c7] hover:bg-[#0369a1] text-white px-3 py-1 rounded font-medium text-[11px] shadow transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Commit Plan (Enter)</span>
            </button>
            <button
              onClick={() => discardAiPlan()}
              className="flex items-center space-x-1 bg-[#1e293b] hover:bg-[#334155] text-[#cbd5e1] px-2.5 py-1 rounded text-[11px] transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Discard (Esc)</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Tier-1 Prompt Input Bar */}
      <div className="flex items-center justify-between px-3 py-1.5 space-x-3">
        {/* Left: AI Driver Indicator & Input */}
        <form onSubmit={handleSubmit} className="flex-1 flex items-center space-x-2">
          <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#262626] border border-[#3b3b3b] text-[#38bdf8] text-[11px] font-semibold">
            <Sparkles className="w-3.5 h-3.5 text-[#38bdf8]" />
            <span className="tracking-wide">AI Driver</span>
          </div>

          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={handleKeyDownInput}
              placeholder="Ask / Do: 'Add 40x30 perimeter walls', 'Insert 36x84 door', 'Construct slab' (Press / or Ctrl+Enter)"
              className="w-full bg-[#242424] text-[#e2e8f0] placeholder-[#666666] text-[12px] px-3 py-1 rounded border border-[#3a3a3a] focus:outline-none focus:border-[#38bdf8] focus:ring-1 focus:ring-[#38bdf8] transition-all"
            />
            {isSynthesizing && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[#38bdf8] text-[11px] flex items-center space-x-1">
                <span className="animate-spin w-3 h-3 border-2 border-[#38bdf8] border-t-transparent rounded-full" />
                <span>Synthesizing Plan...</span>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={!promptText.trim() || isSynthesizing}
            className="flex items-center space-x-1 bg-[#094771] hover:bg-[#0b5c91] disabled:bg-[#2a2a2a] disabled:text-[#555555] text-white px-3 py-1 rounded text-[11px] font-medium transition-colors"
          >
            <span>Generate Plan</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </form>

        {/* Right: Quick actions & Journal toggle */}
        <div className="flex items-center space-x-2 text-[11px] text-[#888888]">
          {/* Preset Chips */}
          <div className="hidden lg:flex items-center space-x-1">
            {samplePrompts.slice(0, 3).map((prompt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setPromptText(prompt);
                  setTimeout(() => inputRef.current?.focus(), 20);
                }}
                className="bg-[#242424] hover:bg-[#303030] text-[#a1a1aa] hover:text-[#e4e4e7] px-2 py-0.5 rounded text-[10px] border border-[#333333] transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              setShowJournal(!showJournal);
              if (!showJournal) fetchTransactionJournal();
            }}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] transition-colors ${
              showJournal
                ? 'bg-[#0369a1] text-white border-[#0284c7]'
                : 'bg-[#242424] text-[#a1a1aa] hover:text-white border-[#333333]'
            }`}
            title="View CommandBus Journal and Transaction History"
          >
            <History className="w-3 h-3 text-[#38bdf8]" />
            <span>Journal</span>
            {showJournal ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );
};
