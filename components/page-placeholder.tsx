import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type PagePlaceholderProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Labels for the placeholder cards in the page body. */
  sections: string[];
};

/** Stand-in page body until each section gets its real content. */
export function PagePlaceholder({
  title,
  description,
  icon: Icon,
  sections,
}: PagePlaceholderProps) {
  return (
    <div className="flex flex-1 flex-col gap-8 p-6 md:p-10">
      <div className="flex flex-col gap-3">
        <Badge variant="secondary" className="w-fit gap-1.5">
          <Icon />
          Placeholder
        </Badge>
        <h1 className="font-display text-5xl leading-none uppercase md:text-6xl">
          {title}
        </h1>
        <p className="max-w-xl text-muted-foreground">{description}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sections.map((section) => (
          <Card key={section}>
            <CardHeader>
              <CardTitle>{section}</CardTitle>
              <CardDescription>Coming soon</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
