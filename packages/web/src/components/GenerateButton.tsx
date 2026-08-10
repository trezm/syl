import { useState } from "react";

interface GenerateButtonProps {
  label: string;
  onClick: () => Promise<void>;
  className?: string;
  size?: "sm" | "md";
  /** Worth setting where the label alone doesn't say what will be generated. */
  title?: string;
}

export default function GenerateButton({
  label,
  onClick,
  className = "",
  size = "sm",
  title,
}: GenerateButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    setError(null);
    try {
      await onClick();
    } catch (err: any) {
      setError(err.message || "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  const sizeClasses =
    size === "sm"
      ? "px-2 py-0.5 text-[10px]"
      : "px-3 py-1 text-xs";

  return (
    <span className="inline-flex items-center gap-1">
      <button
        className={`${sizeClasses} bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 rounded text-purple-300 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        onClick={handleClick}
        disabled={loading}
        title={title}
      >
        {loading ? (
          <span className="inline-flex items-center gap-1">
            <svg
              className="animate-spin h-3 w-3"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Generating...
          </span>
        ) : (
          label
        )}
      </button>
      {error && (
        <span className="text-[10px] text-red-400 max-w-[120px] truncate" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
