import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const STAGES = [
  { label: "Research", hint: "About a minute" },
  { label: "Generate", hint: "Coming next" },
  { label: "Review & iterate", hint: "Coming next" },
  { label: "Approve & export", hint: "Coming next" },
];

/** Where the user is in the URL → ads loop. Only Research exists so far. */
export function StageStepper({ researchDone }: { researchDone: boolean }) {
  const current = researchDone ? 1 : 0;

  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Campaign progress">
      {STAGES.map((stage, i) => {
        const complete = i < current;
        const active = i === current;
        return (
          <li key={stage.label} className="flex flex-col items-center gap-2 text-center">
            <div className="flex w-full items-center">
              <span
                className={cn("h-px flex-1", i === 0 ? "bg-transparent" : i <= current ? "bg-foreground" : "bg-border")}
              />
              <span
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  complete && "border-foreground bg-foreground text-background",
                  active && "border-foreground bg-background text-foreground ring-4 ring-foreground/10",
                  !complete && !active && "border-border bg-background text-muted-foreground",
                )}
              >
                {complete ? <CheckIcon className="size-4" /> : i + 1}
              </span>
              <span
                className={cn("h-px flex-1", i === STAGES.length - 1 ? "bg-transparent" : i < current ? "bg-foreground" : "bg-border")}
              />
            </div>
            <div>
              <p className={cn("text-xs font-medium sm:text-sm", !complete && !active && "text-muted-foreground")}>
                {stage.label}
              </p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {complete ? "Done" : stage.hint}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
