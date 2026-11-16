import {
  DEFAULT_GUEST_GUIDELINES,
  DEFAULT_PADRINHOS_SLOTS,
  DEFAULT_SITE_SETTINGS,
} from '../data/defaults';
import { DressCodeColor, GuestGuidelineIcon, GuestGuidelineItem, PadrinhoEntry, SiteSettings } from '../types/wedding';

const VALID_GUIDELINE_ICONS: GuestGuidelineIcon[] = ['clock', 'smartphone', 'camera', 'heart', 'sparkles'];

export function normalizeVenueCityDisplay(rawCity?: string): string {
  const cleaned = (rawCity || '')
    .replace(/,?\s*CEP\s*\d{5}-?\d{3}/gi, '')
    .trim();
  return cleaned || DEFAULT_SITE_SETTINGS.venueCity;
}

export function resolveCeremonyPastor(rawPastor?: string): string {
  const clean = (rawPastor || '').trim();
  if (!clean || /^fabiano paulo$/i.test(clean)) {
    return DEFAULT_SITE_SETTINGS.ceremonyPastor || 'Pr. Fabiano Paulo de Andrade';
  }
  return clean;
}

export function sanitizeDressCodeColors(items?: DressCodeColor[]): DressCodeColor[] {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 16)
    .map((item, idx) => ({
      id: (item?.id || `color-${idx + 1}`).toString().slice(0, 80),
      name: (item?.name ?? '').toString().trim().slice(0, 60),
      hex: /^#[0-9a-fA-F]{3,8}$/.test((item?.hex || '').trim())
        ? item.hex.trim()
        : '#C6A46A',
    }));
}

export function sanitizeGuestGuidelines(items?: GuestGuidelineItem[]): GuestGuidelineItem[] {
  if (!Array.isArray(items)) return DEFAULT_GUEST_GUIDELINES;
  return items
    .slice(0, 10)
    .filter((item) => item && (item.title?.trim() || item.description?.trim()))
    .map((item, idx) => ({
      id: (item.id || `guide-${idx + 1}`).toString().slice(0, 80),
      title: (item.title || 'Orientação').trim().slice(0, 80),
      description: (item.description || '-').trim().slice(0, 400),
      icon: VALID_GUIDELINE_ICONS.includes(item.icon) ? item.icon : 'heart',
    }));
}

export function sanitizePadrinhos(items?: PadrinhoEntry[]): PadrinhoEntry[] {
  if (!Array.isArray(items)) return [];
  const seenIds = new Set<string>();
  const result: PadrinhoEntry[] = [];
  for (let idx = 0; idx < items.length && result.length < 30; idx++) {
    const item = items[idx];
    const id = (item?.id || `padrinho-${idx + 1}`).toString().slice(0, 80);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    result.push({
      id,
      side: item?.side === 'noivo' ? 'noivo' : 'noiva',
      name: (item?.name ?? '').toString().trim().slice(0, 120),
      published: item?.published !== false,
      order: Math.min(100, Math.max(0, Math.round(Number(item?.order) || idx + 1))),
    });
  }
  return result;
}

const LEGACY_MADRINHAS_UPGRADE_MAP: Record<string, string> = {
  gessica: 'Géssica Bahia',
  enndy: 'Anndy Tainá',
  'enndy taina dias andrade': 'Anndy Tainá',
  cibelly: 'Cibelly Vitória',
  'cibelly vitoria batista': 'Cibelly Vitória',
  debora: 'Debora Caroline',
  cecilia: 'Cecília Barbosa Alves',
  kayriny: 'Kayriny Coutinho',
};

const LEGACY_PADRINHOS_UPGRADE_MAP: Record<string, string> = {
  'lucas gaucho': 'Lucas Oliveira',
};

export function resolvePadrinhosList(items?: PadrinhoEntry[]): PadrinhoEntry[] {
  if (!Array.isArray(items) || items.length === 0) {
    return DEFAULT_PADRINHOS_SLOTS;
  }
  const hasAnyNamed = items.some((p) => Boolean(p?.name?.trim()));
  if (!hasAnyNamed) {
    return DEFAULT_PADRINHOS_SLOTS;
  }
  return sanitizePadrinhos(items).map((entry) => {
    const normalized = entry.name
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const upgradeMap =
      entry.side === 'noiva' ? LEGACY_MADRINHAS_UPGRADE_MAP : LEGACY_PADRINHOS_UPGRADE_MAP;
    const upgradedName = upgradeMap[normalized];
    if (upgradedName && entry.name.trim() !== upgradedName) {
      return { ...entry, name: upgradedName };
    }
    return entry;
  });
}

/**
 * Strips any `undefined` properties and normalizes strings/lists to match firestore.rules strictly.
 */
export function sanitizeSiteSettingsForFirestore(raw: SiteSettings): Record<string, unknown> {
  return {
    coupleNames: (raw.coupleNames || DEFAULT_SITE_SETTINGS.coupleNames).trim().slice(0, 100),
    weddingDateIso: (raw.weddingDateIso || DEFAULT_SITE_SETTINGS.weddingDateIso).trim().slice(0, 40),
    weddingDateDisplay: (raw.weddingDateDisplay ?? DEFAULT_SITE_SETTINGS.weddingDateDisplay).trim().slice(0, 100),
    weddingTimeDisplay: (raw.weddingTimeDisplay ?? DEFAULT_SITE_SETTINGS.weddingTimeDisplay).trim().slice(0, 40),
    venueName: (raw.venueName || DEFAULT_SITE_SETTINGS.venueName).trim().slice(0, 200),
    venueCity: normalizeVenueCityDisplay(raw.venueCity).slice(0, 120),
    venueCep: (raw.venueCep ?? DEFAULT_SITE_SETTINGS.venueCep ?? '').trim().slice(0, 20),
    venueStreetAddress: (raw.venueStreetAddress ?? '').trim().slice(0, 240),
    venueCoordinates: (raw.venueCoordinates ?? '').trim().slice(0, 80),
    venueMapUrl: (raw.venueMapUrl ?? '').trim().slice(0, 500),
    venuePhotoUrl: (raw.venuePhotoUrl ?? '').trim().slice(0, 600),
    ceremonyPastor: (raw.ceremonyPastor ?? DEFAULT_SITE_SETTINGS.ceremonyPastor ?? '').trim().slice(0, 120),
    ceremonyPlanner: (raw.ceremonyPlanner ?? DEFAULT_SITE_SETTINGS.ceremonyPlanner ?? '').trim().slice(0, 120),
    dressCodeImageUrl: (raw.dressCodeImageUrl ?? '').trim().slice(0, 600),
    dressCodeColors: sanitizeDressCodeColors(raw.dressCodeColors),
    dressCodeMessage: (raw.dressCodeMessage ?? DEFAULT_SITE_SETTINGS.dressCodeMessage ?? '').trim().slice(0, 600),
    guestGuidelines: sanitizeGuestGuidelines(raw.guestGuidelines),
    padrinhos: sanitizePadrinhos(raw.padrinhos),
    publicShareUrl: (raw.publicShareUrl ?? '').trim().slice(0, 200),
    heroQuote: (raw.heroQuote || DEFAULT_SITE_SETTINGS.heroQuote).trim().slice(0, 400),
    storyIntro: (raw.storyIntro ?? '').trim().slice(0, 1500),
    giftIntroMessage: (raw.giftIntroMessage || DEFAULT_SITE_SETTINGS.giftIntroMessage).trim().slice(0, 500),
    rsvpDeadlineIso: (raw.rsvpDeadlineIso ?? '').trim().slice(0, 40),
    rsvpMaxGuestsPerSubmission: Math.min(15, Math.max(1, Number(raw.rsvpMaxGuestsPerSubmission) || 6)),
    giftReservationExpiryMinutes: Math.min(10080, Math.max(5, Number(raw.giftReservationExpiryMinutes) || 60)),
    pixEnabled: Boolean(raw.pixEnabled),
    pixKey: (raw.pixKey ?? '').trim().slice(0, 140),
    pixKeyType: raw.pixKeyType || 'unconfigured',
    pixBeneficiaryName: (raw.pixBeneficiaryName ?? '').trim().slice(0, 80),
    pixCity: (raw.pixCity ?? '').trim().slice(0, 40),
    pixProviderMode: raw.pixProviderMode || 'demo_unconfigured',
    goalAmountCents: Math.max(0, Math.round(Number(raw.goalAmountCents) || 0)),
    goalTitle: (raw.goalTitle ?? '').trim().slice(0, 140),
    lgpdContactEmail: (raw.lgpdContactEmail ?? '').trim().slice(0, 160),
  };
}
