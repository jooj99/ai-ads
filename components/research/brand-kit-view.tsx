"use client";

/* eslint-disable @next/next/no-img-element -- logos and product photos come from
   each store's own CDN (any host), so they're shown as plain images. */

import { CheckIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { BrandFont, BrandKit, CatalogItem, SelectedProduct } from "@/lib/research/types";
import { cn } from "@/lib/utils";

type Source = "site" | "ai";

/**
 * Labels where a section's content came from: read off the site, inferred by
 * the model, or edited by the user or agent (research re-runs keep edits, so
 * an edited section no longer just reflects the site).
 */
function SourceBadge({ source, edited = false }: { source: Source; edited?: boolean }) {
  if (edited) {
    return (
      <Badge
        variant="secondary"
        className="gap-1 font-normal"
        title="Changed by you or the agent; research re-runs keep it"
      >
        <PencilIcon className="size-3" />
        Edited
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {source === "site" ? "From site" : "AI inferred"}
    </Badge>
  );
}

function Section({
  title,
  source,
  edited,
  className,
  children,
}: {
  title: string;
  source: Source;
  edited?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <SourceBadge source={source} edited={edited} />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Whether the user or agent edited any of these kit fields (see `brand_kits.edited`). */
function isEdited(kit: BrandKit, ...fields: string[]) {
  return fields.some((f) => kit.edited?.includes(f));
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

/**
 * The brand kit tab: identity, value prop, colors, fonts, audience and voice.
 * Layouts respond to the panel's width (container queries), not the window's.
 */
export function BrandKitView({
  kit,
  pending,
  onRemoveColor,
  onRemoveFont,
  onAudienceChange,
}: {
  kit: BrandKit;
  pending: boolean;
  /** When set (and research isn't running), colors and fonts get a remove button. */
  onRemoveColor?: (hex: string) => void;
  onRemoveFont?: (family: string) => void;
  /** When set (and research isn't running), audience tags can be removed and added. */
  onAudienceChange?: (segments: string[]) => void;
}) {
  const removeColor = pending ? undefined : onRemoveColor;
  const removeFont = pending ? undefined : onRemoveFont;
  const changeAudience = pending ? undefined : onAudienceChange;
  return (
    <div className="flex flex-col gap-4">
      <IdentityRow kit={kit} pending={pending} />

      {/* Colors and fonts share a row. */}
      <div className="grid gap-4 @lg:grid-cols-2">
        <Section title="Colors" source="site" edited={isEdited(kit, "colors")}>
          {kit.colors.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
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

        <Section title="Fonts" source="site" edited={isEdited(kit, "fonts")}>
          {kit.fonts.length ? (
            <ul className="flex flex-col gap-3">
              {kit.fonts.map((font) => (
                <FontRow
                  key={font.family}
                  font={font}
                  brand={kit.name ?? kit.domain}
                  sampleLine={kit.voice?.sampleLine}
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
      </div>

      {/* Audience and voice share a row too. */}
      <div className="grid gap-4 @lg:grid-cols-2">
        <Section title="Audience" source="ai" edited={isEdited(kit, "audience.segments")}>
          {kit.audience?.segments?.length || (!pending && changeAudience) ? (
            <AudienceTags segments={kit.audience?.segments ?? []} onChange={changeAudience} />
          ) : pending ? (
            <div className="flex flex-wrap gap-1.5">
              {[20, 28, 24, 16].map((w) => (
                <Skeleton key={w} className="h-6 rounded-full" style={{ width: `${w * 4}px` }} />
              ))}
            </div>
          ) : (
            <Empty>Not available.</Empty>
          )}
        </Section>

        <Section title="Voice" source="ai" edited={isEdited(kit, "voice.summary", "voice.traits")}>
          {kit.voice?.summary ? (
            <p className="text-sm">{kit.voice.summary}</p>
          ) : pending ? (
            <Lines count={2} />
          ) : (
            <Empty>Not available.</Empty>
          )}
        </Section>
      </div>
    </div>
  );
}

/**
 * Who the brand sells to, as tags. Research suggests them; the user can drop
 * any (✕) or add their own. The longer audience description research also
 * writes isn't shown; it only briefs the ad agent.
 */
function AudienceTags({
  segments,
  onChange,
}: {
  segments: string[];
  onChange?: (segments: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function add() {
    const tag = draft.trim();
    setDraft("");
    setAdding(false);
    if (!tag || !onChange) return;
    if (segments.some((s) => s.toLowerCase() === tag.toLowerCase())) return;
    onChange([...segments, tag]);
  }

  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Audience">
      {segments.map((segment) => (
        <li
          key={segment}
          // The ✕ takes no room until hover (or keyboard focus), when the
          // bubble grows to the right to reveal it; touch screens always show it.
          className="group flex h-6 items-center rounded-full bg-secondary px-2.5 text-xs text-secondary-foreground transition-[padding] duration-150 max-md:pr-0.5 md:hover:pr-0.5 md:focus-within:pr-0.5"
        >
          {segment}
          {onChange && (
            <button
              type="button"
              onClick={() => onChange(segments.filter((s) => s !== segment))}
              aria-label={`Remove ${segment}`}
              title={`Remove ${segment}`}
              className="ml-0.5 flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full text-muted-foreground transition-all duration-150 hover:bg-foreground/10 hover:text-foreground md:ml-0 md:w-0 md:opacity-0 md:group-hover:ml-0.5 md:group-hover:w-5 md:group-hover:opacity-100 md:group-focus-within:ml-0.5 md:group-focus-within:w-5 md:group-focus-within:opacity-100"
            >
              <XIcon className="size-2.5 shrink-0" />
            </button>
          )}
        </li>
      ))}
      {onChange && segments.length < 12 && (
        <li>
          {adding ? (
            <input
              autoFocus
              value={draft}
              maxLength={40}
              placeholder="New audience"
              aria-label="New audience tag"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              className="h-6 w-32 rounded-full border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-6 items-center gap-1 rounded-full border border-dashed border-foreground/25 px-2.5 text-xs text-muted-foreground hover:border-foreground/50 hover:text-foreground"
            >
              <PlusIcon className="size-3" />
              Add
            </button>
          )}
        </li>
      )}
    </ul>
  );
}

function IdentityRow({ kit, pending }: { kit: BrandKit; pending: boolean }) {
  return (
    <Card>
      <CardContent className="grid gap-6 @lg:grid-cols-[auto_1fr] @lg:items-center @3xl:grid-cols-[auto_1fr_1.2fr]">
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

        <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 @lg:col-span-2 @3xl:col-span-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Value proposition
            </p>
            <SourceBadge source="ai" edited={isEdited(kit, "valueProposition")} />
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

/** Where a font preview's face came from; null while it's still loading. */
type FaceSource = "site" | "google" | "none" | null;

/**
 * A brand font: a small "Aa" tile, and on hover a larger preview (the brand
 * name, a line in its voice, the alphabet) set in that font. The face comes
 * from the site's own font files when research stored them (served by
 * /api/campaigns/<id>/fonts, loaded with the FontFace API), otherwise from
 * Google Fonts, where sites' names like "Exo2" are also tried as "Exo 2". If
 * neither works the card says the preview is a fallback instead of faking it.
 */
function FontRow({
  font,
  brand,
  sampleLine,
  onRemove,
}: {
  font: BrandFont;
  brand: string;
  sampleLine?: string;
  onRemove?: () => void;
}) {
  const spaced = font.family.replace(/([a-z])(\d+)$/i, "$1 $2");
  // The site's files get a private family name so they never clash with a
  // Google Fonts face of the same name.
  const siteFamily = `${font.family} (site)`;
  const siteFiles = JSON.stringify(
    (font.files ?? []).filter((f) => f.url).map((f) => [f.url, f.weight, f.style]),
  );
  const [source, setSource] = useState<FaceSource>(null);

  useEffect(() => {
    let cancelled = false;
    const faces: FontFace[] = [];
    const links: HTMLLinkElement[] = [];

    async function fromSite(): Promise<boolean> {
      const files = JSON.parse(siteFiles) as [string, number, string][];
      if (!files.length) return false;
      try {
        for (const [url, weight, style] of files) {
          const face = new FontFace(siteFamily, `url(${url})`, { weight: String(weight), style });
          faces.push(face);
          document.fonts.add(face);
        }
        await Promise.all(faces.map((f) => f.load()));
        return true;
      } catch {
        return false;
      }
    }

    function fromGoogle(): Promise<boolean> {
      const names = [...new Set([font.family, spaced])];
      return Promise.all(
        names.map((name) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}&display=swap`;
          document.head.appendChild(link);
          links.push(link);
          return new Promise<boolean>((resolve) => {
            link.onload = () =>
              document.fonts
                .load(`400 24px "${name}"`)
                .then((loaded) => resolve(loaded.length > 0), () => resolve(false));
            link.onerror = () => resolve(false);
          });
        }),
      ).then((results) => results.some(Boolean));
    }

    void (async () => {
      const next: FaceSource = (await fromSite()) ? "site" : (await fromGoogle()) ? "google" : "none";
      if (!cancelled) setSource(next);
    })();

    return () => {
      cancelled = true;
      faces.forEach((f) => document.fonts.delete(f));
      links.forEach((l) => l.remove());
    };
  }, [font.family, spaced, siteFamily, siteFiles]);

  const face = { fontFamily: `"${siteFamily}", "${font.family}", "${spaced}", var(--font-sans)` };

  return (
    <li className="group flex items-center gap-3">
      <HoverCard openDelay={150} closeDelay={50}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label={`Preview ${font.family}`}
          >
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xl transition-colors group-hover:bg-foreground group-hover:text-background"
              style={face}
              aria-hidden="true"
            >
              Aa
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{font.family}</span>
              <span className="block text-xs text-muted-foreground">{font.role}</span>
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent align="start" className="flex w-80 flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{font.family}</span>
            <span>{font.role}</span>
          </div>
          <div className="flex flex-col gap-2" style={face}>
            <p className="text-3xl leading-tight break-words">{brand}</p>
            <p className="text-base leading-snug">
              {sampleLine ?? "The quick brown fox jumps over the lazy dog."}
            </p>
            <p className="text-sm leading-relaxed break-all text-muted-foreground">
              ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789
            </p>
          </div>
          {source && (
            <p className="border-t pt-2 text-xs text-muted-foreground">
              {source === "site"
                ? "Loaded from your site's own font files."
                : source === "google"
                  ? "Loaded from Google Fonts."
                  : "Couldn't load this font from your site or Google Fonts, so the preview may show a fallback face."}
            </p>
          )}
        </HoverCardContent>
      </HoverCard>
      {onRemove && <RemoveButton label={`Remove ${font.family}`} onClick={onRemove} />}
    </li>
  );
}

const PAGE_SIZE = 24;
const ALL = "all";
const HERO = "hero";

/**
 * The whole catalog with filters (the Products tab): All, Hero picks, and one per product type.
 * Heroes sort first and carry their features; every other item shows its
 * photo, type and price.
 */
export function ProductPicks({ kit, pending }: { kit: BrandKit; pending: boolean }) {
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
        {isEdited(kit, "productTypes") ? (
          <Badge
            variant="secondary"
            className="gap-1 font-normal"
            title="Grouping and heroes set by you or the agent; research re-runs keep them"
          >
            <PencilIcon className="size-3" />
            From site · grouping edited
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {kit.productsPickedBy === "default"
              ? "From site · grouped by listed type"
              : "From site · grouped by AI"}
          </Badge>
        )}
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
            <ul className="grid gap-x-4 gap-y-6 @md:grid-cols-2 @3xl:grid-cols-3">
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
          <div className="grid gap-4 @md:grid-cols-2 @3xl:grid-cols-3">
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
          // Not everything a business sells has a photo (a plan, an integration);
          // show the name as a typographic tile rather than a broken-image icon.
          <div className="flex aspect-[4/5] flex-col justify-end gap-2 bg-muted p-5">
            <span className="line-clamp-4 font-display text-3xl leading-none break-words text-foreground/85 uppercase">
              {item.title}
            </span>
            <span className="text-xs text-muted-foreground">No photo on the site</span>
          </div>
        )}
        {hero && (
          <Badge className="absolute top-2 left-2 gap-1 shadow-sm">
            <StarIcon className="size-3" />
            Hero
          </Badge>
        )}
        {item.origin && item.origin !== "research" && (
          <Badge variant="secondary" className="absolute top-2 right-2 font-normal shadow-sm">
            {item.origin === "agent" ? "Added by agent" : "Added by you"}
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
