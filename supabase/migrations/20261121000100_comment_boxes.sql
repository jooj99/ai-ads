-- A comment can mark an area instead of a spot: the user drags a box on the
-- ad. x/y stay the center (a pin's spot, a box's middle); w/h are the box's
-- width and height as fractions of the ad, or null for a pin.
alter table public.ad_comments
  add column w real check (w > 0 and w <= 1),
  add column h real check (h > 0 and h <= 1),
  add constraint ad_comments_box_both check ((w is null) = (h is null));

notify pgrst, 'reload schema';
