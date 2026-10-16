import React, { useState, useEffect, useRef } from 'react';
import { useBimStore } from '../../store/useBimStore';
import { formatLength, tryParseLength } from '../../utils/units';

interface ValueControlBoxProps {
  currentLiveValue?: number | null;
  liveLabel?: string;
  onCommitLiveValue?: (value: number) => void;
  className?: string;
}

export const ValueControlBox: React.FC<ValueControlBoxProps> = ({
  currentLiveValue,
  liveLabel,
  onCommitLiveValue,
  className = '',
}) => {
  const {
    lastGestureCommit,
    retypeCommittedValue,
    displayUnit,
    tempDimension,
    applyTemporaryDimensionChange,
    activeDragSessionId,
    activeTool,
    setStatusMessage,
  } = useBimStore();

  const [inputValue, setInputValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Determine active context
  const isDragging = Boolean(activeDragSessionId || currentLiveValue !== undefined && currentLiveValue !== null);
  const isWallCreating = activeTool === 'WA' && currentLiveValue !== undefined && currentLiveValue !== null;
  const hasCommit = Boolean(lastGestureCommit);
  const hasTempDim = Boolean(tempDimension);

  const isVisible = isDragging || isWallCreating || hasCommit || hasTempDim;

  // Determine current label and formatted value
  let activeLabel = 'Value';
  let formattedDisplay = '';

  if (isDragging || isWallCreating) {
    activeLabel = liveLabel || (isWallCreating ? 'Wall Length' : 'Length');
    if (currentLiveValue !== null && currentLiveValue !== undefined) {
      formattedDisplay = formatLength(currentLiveValue, displayUnit);
    }
  } else if (hasCommit && lastGestureCommit) {
    if (lastGestureCommit.action === 'modifyWallHeight') {
      activeLabel = 'Height';
      formattedDisplay = formatLength(lastGestureCommit.params.height ?? 0, displayUnit);
    } else if (lastGestureCommit.action === 'modifyWallThickness') {
      activeLabel = 'Thickness';
      formattedDisplay = formatLength(lastGestureCommit.params.thickness ?? 0, displayUnit);
    } else if (lastGestureCommit.action === 'modifyWallEnd' || lastGestureCommit.action === 'createWall') {
      activeLabel = 'Wall Length';
      const sp = lastGestureCommit.params.start || lastGestureCommit.params.point;
      const ep = lastGestureCommit.params.end;
      if (sp && ep) {
        const len = Math.hypot(ep[0] - sp[0], ep[1] - sp[1]);
        formattedDisplay = formatLength(len, displayUnit);
      } else {
        formattedDisplay = formatLength(lastGestureCommit.params.value ?? 0, displayUnit);
      }
    } else {
      activeLabel = lastGestureCommit.paramKey || 'Value';
      formattedDisplay = String(lastGestureCommit.params.value ?? '');
    }
  } else if (hasTempDim && tempDimension) {
    activeLabel = 'Distance';
    formattedDisplay = tempDimension.displayValue || formatLength(tempDimension.distance, displayUnit);
  }

  // Update input text when display changes and input is not focused
  useEffect(() => {
    if (!isFocused) {
      setInputValue(formattedDisplay);
    }
  }, [formattedDisplay, isFocused]);

  if (!isVisible) return null;

  const handleSubmit = async () => {
    if (!inputValue.trim()) return;

    const feet = tryParseLength(inputValue);
    if (feet === null || feet <= 0) {
      setStatusMessage(`Invalid length: "${inputValue}". Enter format like 12'-6", 14.5', or 3800mm.`);
      return;
    }

    if (onCommitLiveValue && (isDragging || isWallCreating)) {
      onCommitLiveValue(feet);
      inputRef.current?.blur();
      return;
    }

    if (hasCommit) {
      const ok = await retypeCommittedValue(inputValue);
      if (ok) {
        setStatusMessage(`Updated ${activeLabel} to ${formatLength(feet, displayUnit)}`);
      } else {
        setStatusMessage(`Could not apply ${inputValue}`);
      }
      inputRef.current?.blur();
      return;
    }

    if (hasTempDim) {
      await applyTemporaryDimensionChange(feet);
      inputRef.current?.blur();
      return;
    }
  };

  return (
    <div
      className={`bg-[#18181b]/90 backdrop-blur-md border ${
        isFocused ? 'border-[#38bdf8] ring-1 ring-sky-400' : 'border-[#3f3f46]'
      } rounded-lg shadow-xl px-3 py-1.5 flex items-center space-x-2 text-xs font-mono select-none z-30 transition-all ${className}`}
    >
      <span className="text-[#a1a1aa] font-sans font-medium text-[11px] whitespace-nowrap">
        {activeLabel}:
      </span>
      <input
        ref={inputRef}
        type="text"
        value={isFocused ? inputValue : (inputValue || formattedDisplay)}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={() => {
          setIsFocused(true);
          setInputValue(formattedDisplay);
        }}
        onBlur={() => {
          setIsFocused(false);
          setInputValue(formattedDisplay);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setIsFocused(false);
            setInputValue(formattedDisplay);
            inputRef.current?.blur();
          }
        }}
        placeholder={formattedDisplay || '12\'-6"'}
        className="w-24 px-1.5 py-0.5 bg-[#27272a] text-white rounded border border-[#52525b] focus:border-[#38bdf8] focus:bg-[#090d16] outline-none text-xs font-mono text-center"
      />
      {hasCommit && !isDragging && (
        <span className="text-[10px] text-[#71717a] font-sans whitespace-nowrap">
          (Type to re-specify)
        </span>
      )}
    </div>
  );
};
