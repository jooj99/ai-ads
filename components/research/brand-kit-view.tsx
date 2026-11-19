"use client";

/* eslint-disable @next/next/no-img-element -- logos and product photos come from
   each store's own CDN (any host), so they're shown as plain images. */

import { CheckIcon, ImageOffIcon, QuoteIcon, StarIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { BrandFont, BrandKit, CatalogItem, SelectedProduct } from "@/lib/research/types";
import { cn } from "@/lib/utils";

type Source = "site" | "ai";

/** Labels whether a section was read off the site or inferred by the model. */
function SourceBadge({ source }: { source: Source }) {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {source === "site" ? "From site" : "AI inferred"}
    </Badge>
  );
}

function Section({
  title,
  source,
  className,
  children,
}: {
  title: string;
  source: Source;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <SourceBadge source={source} />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Lines({ count = 2 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === count - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Shopify's CDN resizes on the fly; ask for thumbnails instead of originals. */
function thumbnail(src: string, width: number) {
  try {
    const url = new URL(src);
    if (url.hostname === "cdn.shopify.com" || url.pathname.includes("/cdn/shop/")) {
      url.searchParams.set("width", String(width));
      return url.href;
    }
  } catch {}
  return src;
}

/** Small ✕ shown on hover (always on touch screens) for removing an item. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
    >
      <XIcon className="size-3.5" />
    </button>
  );
}

export function BrandKitView({
  kit,
  pending,
  onRemoveColor,
  onRemoveFont,
}: {
  kit: BrandKit;
  pending: boolean;
  /** When set (and research isn't running), colors and fonts get a remove button. */
  onRemoveColor?: (hex: string) => void;
  onRemoveFont?: (family: string) => void;
}) {
  const removeColor = pending ? undefined : onRemoveColor;
  const removeFont = pending ? undefined : onRemoveFont;
  return (
    <div className="flex flex-col gap-4">
      <IdentityRow kit={kit} pending={pending} />

      <div className="grid gap-4 md:grid-cols-3">
        <Section title="Colors" source="site">
          {kit.colors.length ? (
            <ul className="grid grid-cols-2 gap-3">
              {kit.colors.map((color) => (
                <li key={color.hex} className="group flex items-center gap-2">
                  <span
                    className="size-8 shrink-0 rounded-full ring-1 ring-foreground/10"
                    style={{ backgroundColor: color.hex }}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs">{color.hex}</span>
                    <span className="block truncate text-xs text-muted-foreground">{color.role}</span>
                  </span>
                  {removeColor && (
                    <RemoveButton label={`Remove ${color.hex}`} onClick={() => removeColor(color.hex)} />
                  )}
                </li>
              ))}
            </ul>
          ) : pending ? (
            <div className="flex gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="size-8 rounded-full" />
              ))}
            </div>
          ) : (
            <Empty>No brand colors found.</Empty>
          )}
        </Section>

        <Section title="Fonts" source="site">
          {kit.fonts.length ? (
            <ul className="flex flex-col gap-3">
              {kit.fonts.map((font) => (
                <FontRow
                  key={font.family}
                  font={font}
                  onRemove={removeFont ? () => removeFont(font.family) : undefined}
                />
              ))}
            </ul>
          ) : pending ? (
            <Lines count={3} />
          ) : (
            <Empty>No custom fonts found.</Empty>
          )}
        </Section>

        <Section title="Audience" source="ai">
          {kit.audience?.summary ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">{kit.audience.summary}</p>
              <div className="flex flex-wrap gap-1.5">
                {kit.audience.segments?.map((segment) => (
                  <Badge key={segment} variant="secondary">
                    {segment}
                  </Badge>
                ))}
              </div>
            </div>
          ) : pending ? (
            <Lines count={3} />
          ) : (
            <Empty>Not available.</Empty>
          )}
        </Section>
      </div>

      <Section title="Voice" source="ai">
        {kit.voice?.summary ? (
          <div className="grid gap-4 md:grid-cols-2">
            <p className="text-sm">{kit.voice.summary}</p>
            {kit.voice.sampleLine && (
              <figure className="flex gap-3 rounded-lg bg-muted p-4">
                <QuoteIcon className="size-4 shrink-0 text-muted-foreground" />
                <div>
                  <blockquote className="text-base font-semibold leading-snug">
                    {kit.voice.sampleLine}
                  </blockquote>
                  <figcaption className="mt-1 text-xs text-muted-foreground">
                    Sample headline in this voice
                  </figcaption>
                </div>
              </figure>
            )}
          </div>
        ) : pending ? (
          <Lines count={2} />
        ) : (
          <Empty>Not available.</Empty>
        )}
      </Section>

      <ProductPicks kit={kit} pending={pending} />
    </div>
  );
}

function IdentityRow({ kit, pending }: { kit: BrandKit; pending: boolean }) {
  return (
    <Card>
      <CardContent className="grid gap-6 md:grid-cols-[auto_1fr_1.2fr] md:items-center">
        <LogoTile kit={kit} pending={pending} />

        <div className="flex min-w-0 flex-col gap-2">
          {kit.name ? (
            <h3 className="truncate text-2xl font-semibold tracking-tight">{kit.name}</h3>
          ) : (
            <Skeleton className="h-7 w-40" />
          )}
          {kit.tagline ? (
            <p className="text-muted-foreground">{kit.tagline}</p>
          ) : (
            pending && <Skeleton className="h-4 w-48" />
          )}
          {kit.voice?.traits?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {kit.voice.traits.map((trait) => (
                <Badge key={trait} variant="secondary">
                  {trait}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Value proposition
            </p>
            <SourceBadge source="ai" />
          </div>
          {kit.valueProposition ? (
            <p className="text-sm leading-relaxed">{kit.valueProposition}</p>
          ) : pending ? (
            <Lines count={3} />
          ) : (
            <Empty>Not available.</Empty>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LogoTile({ kit, pending }: { kit: BrandKit; pending: boolean }) {
  // Walk down the candidates if one fails to load (hotlink blocks, 404s).
  const [failed, setFailed] = useState<string[]>([]);
  const logo = kit.logoCandidates.find((c) => !failed.includes(c)) ?? kit.logo;

  return (
    <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-3 ring-1 ring-foreground/10">
      {logo && !failed.includes(logo) ? (
        <img
          src={logo}
          alt={`${kit.name ?? kit.domain} logo`}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailed((f) => [...f, logo])}
        />
      ) : pending ? (
        <Skeleton className="size-full" />
      ) : (
        <span className="text-center text-xs text-muted-foreground">No logo found</span>
      )}
    </div>
  );
}

/**
 * Previews each font in its own face when Google Fonts has it. Sites often
 * declare names like "Exo2" for Google's "Exo 2", so both spellings are tried.
 */
function FontRow({ font, onRemove }: { font: BrandFont; onRemove?: () => void }) {
  useEffect(() => {
    const names = new Set([font.family, font.family.replace(/([a-z])(\d+)$/i, "$1 $2")]);
    const links = [...names].map((name) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}&display=swap`;
      document.head.appendChild(link);
      return link;
    });
    return () => links.forEach((link) => link.remove());
  }, [font.family]);

  const spaced = font.family.replace(/([a-z])(\d+)$/i, "$1 $2");

  return (
    <li className="group flex items-center gap-3">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xl"
        style={{ fontFamily: `"${font.family}", "${spaced}", var(--font-sans)` }}
        aria-hidden="true"
      >
        Aa
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{font.family}</span>
        <span className="block text-xs text-muted-foreground">{font.role}</span>
      </span>
      {onRemove && <RemoveButton label={`Remove ${font.family}`} onClick={onRemove} />}
    </li>
  );
}

const PAGE_SIZE = 24;
const ALL = "all";
const HERO = "hero";

/**
 * The whole catalog with filters: All, Hero picks, and one per product type.
 * Heroes sort first and carry their features; every other item shows its
 * photo, type and price.
 */
function ProductPicks({ kit, pending }: { kit: BrandKit; pending: boolean }) {
  const services = kit.offering === "services";
  const noun = services ? "service" : "product";
  const heroes = new Map(kit.products.map((p) => [p.id, p]));
  // Older campaigns saved only their hero picks; show those until re-researched.
  const catalog: CatalogItem[] = kit.catalog?.length
    ? kit.catalog
    : kit.products.map((p) => ({ ...p, isHero: true }));

  const typeOrder = [
    ...kit.productTypes.map((t) => t.name),
    ...new Set(
      catalog
        .map((i) => i.typeName)
        .filter((t): t is string => Boolean(t) && !kit.productTypes.some((k) => k.name === t)),
    ),
  ];
  const rank = new Map(typeOrder.map((t, i) => [t, i]));
  const countOf = (type: string) => catalog.filter((i) => i.typeName === type).length;

  const [filter, setFilter] = useState<string>(ALL);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const active = filter === ALL || filter === HERO || rank.has(filter) ? filter : ALL;

  const visible = catalog
    .filter((i) =>
      active === ALL ? true : active === HERO ? heroes.has(i.id) : i.typeName === active,
    )
    .sort(
      (a, b) =>
        Number(heroes.has(b.id)) - Number(heroes.has(a.id)) ||
        (rank.get(a.typeName ?? "") ?? 99) - (rank.get(b.typeName ?? "") ?? 99),
    );

  function choose(next: string) {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }

  const chips = [
    { id: ALL, label: "All", count: catalog.length },
    { id: HERO, label: "Hero picks", count: heroes.size },
    ...typeOrder.map((t) => ({ id: t, label: t, count: countOf(t) })),
  ];

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            Product selection
            {services && <Badge variant="secondary">Services</Badge>}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {catalog.length > 0
              ? `${catalog.length} ${noun}${catalog.length === 1 ? "" : "s"} in ${kit.productTypes.length} type${
                  kit.productTypes.length === 1 ? "" : "s"
                } · ${heroes.size} hero pick${heroes.size === 1 ? "" : "s"} to feature in ads`
              : `The ${noun}s to feature in ads, grouped by type`}
          </p>
        </div>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {kit.productsPickedBy === "default"
            ? "From site · grouped by listed type"
            : "From site · grouped by AI"}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {catalog.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Filter ${noun}s`}>
            {chips.map((chip) => (
              <Button
                key={chip.id}
                type="button"
                size="sm"
                variant={active === chip.id ? "default" : "outline"}
                aria-pressed={active === chip.id}
                onClick={() => choose(chip.id)}
                className="gap-1.5"
              >
                {chip.id === HERO && <StarIcon className="size-3.5" />}
                {chip.label}
                <span className="tabular-nums opacity-60">{chip.count}</span>
              </Button>
            ))}
          </div>
        )}

        {visible.length ? (
          <>
            <ul className="grid gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {visible.slice(0, limit).map((item) => (
                <ProductCard key={item.id} item={item} hero={heroes.get(item.id)} />
              ))}
            </ul>
            {visible.length > limit && (
              <Button
                type="button"
                variant="outline"
                className="self-center"
                onClick={() => setLimit((n) => n + PAGE_SIZE)}
              >
                Show more ({visible.length - limit} left)
              </Button>
            )}
          </>
        ) : pending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="aspect-[4/5] w-full rounded-lg" />
                <Lines count={2} />
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            No {noun}s could be loaded from this site. Adding them by link is coming with the next
            step.
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function ProductCard({ item, hero }: { item: CatalogItem; hero?: SelectedProduct }) {
  const [broken, setBroken] = useState(false);
  // Wide packshots (eyeglasses, shoes) get cropped by a portrait frame; show those whole.
  const [wide, setWide] = useState(false);
  const image = (hero ?? item).images[0];

  return (
    <li className="flex flex-col gap-3">
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="relative block overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10"
      >
        {image && !broken ? (
          <img
            src={thumbnail(image, 600)}
            alt={item.title}
            loading="lazy"
            className={cn(
              "aspect-[4/5] w-full transition-transform duration-300 hover:scale-[1.03]",
              wide ? "bg-white object-contain p-4" : "object-cover",
            )}
            onLoad={(e) =>
              setWide(e.currentTarget.naturalWidth > e.currentTarget.naturalHeight * 1.2)
            }
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="flex aspect-[4/5] items-center justify-center text-muted-foreground">
            <ImageOffIcon className="size-6" />
          </div>
        )}
        {hero && (
          <Badge className="absolute top-2 left-2 gap-1 shadow-sm">
            <StarIcon className="size-3" />
            Hero
          </Badge>
        )}
      </a>
      {item.typeName && (
        <span className="-mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {item.typeName}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-snug">{item.title}</p>
        {item.price && <span className="shrink-0 text-sm text-muted-foreground">{item.price}</span>}
      </div>
      {hero && hero.features.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {hero.features.map((feature) => (
            <li key={feature} className="flex gap-2 text-sm">
              <CheckIcon className="mt-0.5 size-4 shrink-0" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      )}
      {hero?.reason && <p className="text-xs text-muted-foreground">{hero.reason}</p>}
    </li>
  );
}
