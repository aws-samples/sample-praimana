import type { ChatOption } from "../lib/option-buttons";

/**
 * Quick-reply buttons rendered under an assistant message when it ends with an
 * option list (e.g. Approve / Edit the grid / Reject). Clicking one sends the
 * option's short label back to the assistant as the next user message.
 */
export function OptionButtons({
  options,
  disabled,
  onSelect,
}: {
  options: ChatOption[];
  disabled?: boolean;
  onSelect: (label: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {options.map((opt) => (
        <button
          key={opt.label}
          type="button"
          disabled={disabled}
          title={opt.description}
          onClick={() => onSelect(opt.label)}
          className="rounded-full border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 hover:border-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
