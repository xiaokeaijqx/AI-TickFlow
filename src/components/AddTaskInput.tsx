import { useState, useRef } from 'react';

interface Props {
  onAdd: (title: string) => void;
  disabled: boolean;
}

export default function AddTaskInput({ onAdd, disabled }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onAdd(trimmed);
      setValue('');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="+ Add task..."
        disabled={disabled}
        aria-label="Add task"
        className="tick-clean-input h-9 w-full rounded-md border-[0.5px] border-[#D2D7E0] bg-white px-3 text-[13px] font-medium text-[#20242C] outline-none transition-colors placeholder:text-[#7A8290] hover:border-[#C3C9D4] hover:bg-white focus:border-[#B8C0CC] focus:bg-white disabled:opacity-40"
      />
    </div>
  );
}
