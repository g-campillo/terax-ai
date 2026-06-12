import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLspStatusStore } from "@/modules/editor/lib/lsp/statusStore";
import { cn } from "@/lib/utils";

type Props = { filePath: string | null | undefined };

export function LspStatusPill({ filePath }: Props) {
  const status = useLspStatusStore((s) =>
    filePath ? s.byPath[filePath] : undefined,
  );
  if (!status) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
            status.state === "running" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
            status.state === "missing" &&
              "bg-muted text-muted-foreground",
            status.state === "error" &&
              "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
        >
          {status.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-[11px] leading-relaxed">
        {status.state === "running" && "Language server connected."}
        {status.state === "missing" &&
          (status.hint
            ? `No language server found. Install with: ${status.hint}`
            : "No language server found.")}
        {status.state === "error" && (status.hint ?? "Language server error.")}
      </TooltipContent>
    </Tooltip>
  );
}
