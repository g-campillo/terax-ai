import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLspStatusStore } from "@/modules/editor/lib/lsp/statusStore";

type Props = { filePath: string | null | undefined };

export function LspStatusPill({ filePath }: Props) {
  const status = useLspStatusStore((s) =>
    filePath ? s.byPath[filePath] : undefined,
  );
  const restart = useLspStatusStore((s) =>
    filePath ? s.restarters[filePath] : undefined,
  );
  if (!status) return null;
  const canRestart =
    !!restart && (status.state === "error" || status.state === "missing");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
            status.state === "indexing" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            status.state === "running" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            status.state === "missing" && "bg-muted text-muted-foreground",
            status.state === "error" &&
              "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full bg-current",
              status.state === "indexing" && "animate-pulse",
            )}
          />
          {status.state === "indexing"
            ? `${status.label} · indexing…`
            : status.label}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-72 text-[11px] leading-relaxed"
      >
        {status.state === "indexing" &&
          "Indexing the project — completions and other language features may be incomplete until this finishes."}
        {status.state === "running" && "Language server ready."}
        {status.state === "missing" &&
          (status.hint
            ? `No language server found. Install with: ${status.hint}`
            : "No language server found.")}
        {status.state === "error" && (status.hint ?? "Language server error.")}
        {canRestart && (
          <button
            type="button"
            onClick={() => restart?.()}
            className="mt-1.5 block rounded bg-foreground/10 px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-foreground/20"
          >
            Restart server
          </button>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
