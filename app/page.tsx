import { BrandResearch } from "@/components/research/brand-research";

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 p-6 md:p-10">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-5xl leading-none uppercase md:text-6xl">
          From store to ads
        </h1>
        <p className="max-w-xl text-muted-foreground">
          Paste your store&apos;s URL. The agent reads your brand and catalog, then builds the
          brand kit your ads are made from.
        </p>
      </div>
      <BrandResearch />
    </div>
  );
}
