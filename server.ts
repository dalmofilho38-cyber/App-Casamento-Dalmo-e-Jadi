import express from 'express';
import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Simple in-memory rate limiter for public API routes
const rateBucket = new Map<string, { count: number; resetAt: number }>();

function rateLimit(maxRequests = 30, windowMs = 60_000) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const record = rateBucket.get(ip);
    if (!record || now > record.resetAt) {
      rateBucket.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (record.count >= maxRequests) {
      res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.' });
      return;
    }
    record.count += 1;
    next();
  };
}

app.use(express.json({
  limit: '20mb',
  verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));

const MAX_COVERFLOW_FILE_BYTES = 12 * 1024 * 1024; // 12 MB
const COVERFLOW_PUBLIC_DIR = path.resolve(__dirname, 'public', 'images', 'coverflow');
const COVERFLOW_DIST_DIR = path.resolve(__dirname, 'dist', 'images', 'coverflow');
const COVERFLOW_OPT_PUBLIC_DIR = path.resolve(COVERFLOW_PUBLIC_DIR, 'optimized');
const COVERFLOW_OPT_DIST_DIR = path.resolve(COVERFLOW_DIST_DIR, 'optimized');
const ALLOWED_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const ALLOWED_SHARP_FORMATS: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

async function syncFileToDistIfPresent(targetDistDir: string, fileName: string, data: Buffer | string) {
  try {
    const distExists = await fs
      .stat(path.resolve(__dirname, 'dist'))
      .then(() => true)
      .catch(() => false);
    if (distExists) {
      await fs.mkdir(targetDistDir, { recursive: true });
      if (typeof data === 'string') {
        await fs.copyFile(data, path.join(targetDistDir, fileName));
      } else {
        await fs.writeFile(path.join(targetDistDir, fileName), data);
      }
    }
  } catch {
    // ignore dist sync errors in dev
  }
}

async function ensureOptimizedCoverflowVariant(
  filename: string,
  variant: 'card' | 'lightbox'
): Promise<string | null> {
  const safeName = path.basename(filename);
  if (!/^[a-zA-Z0-9._-]+$/.test(safeName)) return null;

  const optFileName = `${safeName}.${variant}.webp`;
  const publicOptPath = path.join(COVERFLOW_OPT_PUBLIC_DIR, optFileName);

  const publicOptExists = await fs
    .stat(publicOptPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (publicOptExists) return publicOptPath;

  const distOptPath = path.join(COVERFLOW_OPT_DIST_DIR, optFileName);
  const distOptExists = await fs
    .stat(distOptPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (distOptExists) return distOptPath;

  const publicOrigPath = path.join(COVERFLOW_PUBLIC_DIR, safeName);
  const distOrigPath = path.join(COVERFLOW_DIST_DIR, safeName);
  const sourcePath = (await fs
    .stat(publicOrigPath)
    .then((s) => (s.isFile() ? publicOrigPath : null))
    .catch(() => null)) ||
    (await fs
      .stat(distOrigPath)
      .then((s) => (s.isFile() ? distOrigPath : null))
      .catch(() => null));

  if (!sourcePath) return null;

  const maxDim = variant === 'lightbox' ? 1600 : 960;
  const quality = variant === 'lightbox' ? 86 : 82;

  await fs.mkdir(COVERFLOW_OPT_PUBLIC_DIR, { recursive: true });
  await sharp(sourcePath)
    .rotate()
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toFile(publicOptPath);

  await syncFileToDistIfPresent(COVERFLOW_OPT_DIST_DIR, optFileName, publicOptPath);
  return publicOptPath;
}

// Always serve permanent project media from public/images in both dev and production
app.use('/images', express.static(path.resolve(__dirname, 'public', 'images')));

app.get('/api/media/coverflow/display/:filename', async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).json({ error: 'Nome de arquivo inválido.' });
      return;
    }

    const variant: 'card' | 'lightbox' =
      req.query.variant === 'lightbox' ? 'lightbox' : 'card';

    try {
      const optimizedPath = await ensureOptimizedCoverflowVariant(filename, variant);
      if (optimizedPath) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(optimizedPath);
        return;
      }
    } catch (optErr) {
      console.warn('Fallback para imagem original do carrossel 3D:', optErr);
    }

    const publicOrigPath = path.join(COVERFLOW_PUBLIC_DIR, filename);
    const hasPublicOrig = await fs
      .stat(publicOrigPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (hasPublicOrig) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(publicOrigPath);
      return;
    }

    const distOrigPath = path.join(COVERFLOW_DIST_DIR, filename);
    const hasDistOrig = await fs
      .stat(distOrigPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (hasDistOrig) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(distOrigPath);
      return;
    }

    res.status(404).json({ error: 'Imagem não encontrada.' });
  } catch (err) {
    console.error('Erro ao servir imagem otimizada da galeria 3D:', err);
    res.status(500).json({ error: 'Não foi possível carregar a imagem.' });
  }
});

app.post(
  '/api/media/coverflow',
  rateLimit(30, 60_000),
  express.raw({
    type: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
    limit: '13mb',
  }),
  async (req, res) => {
    try {
      let buffer: Buffer | null = null;
      let ext: string | undefined;

      if (Buffer.isBuffer(req.body)) {
        const contentType = String(req.header('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        ext = ALLOWED_MIME_EXT[contentType];
        if (!ext) {
          res.status(400).json({ error: 'Formato de imagem não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = req.body;
      } else {
        const { dataUrl } = (req.body || {}) as { dataUrl?: unknown };
        if (typeof dataUrl !== 'string') {
          res.status(400).json({ error: 'Imagem inválida.' });
          return;
        }

        const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
        if (!match) {
          res.status(400).json({ error: 'Formato de imagem não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }

        const mime = match[1].toLowerCase();
        ext = ALLOWED_MIME_EXT[mime];
        if (!ext) {
          res.status(400).json({ error: 'Tipo de imagem não permitido. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = Buffer.from(match[2], 'base64');
      }

      if (!buffer || buffer.length === 0 || buffer.length > MAX_COVERFLOW_FILE_BYTES) {
        res.status(400).json({ error: 'A imagem deve ter no máximo 12 MB.' });
        return;
      }

      const metadata = await sharp(buffer).metadata().catch(() => null);
      const verifiedExt = metadata?.format ? ALLOWED_SHARP_FORMATS[metadata.format] : undefined;
      if (!verifiedExt) {
        res.status(400).json({ error: 'Arquivo inválido. Envie uma imagem JPG, PNG ou WEBP íntegra.' });
        return;
      }

      const safeFileName = `foto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${verifiedExt}`;
      await fs.mkdir(COVERFLOW_PUBLIC_DIR, { recursive: true });
      // Save untouched original bytes to preserve 100% of original photograph quality
      await fs.writeFile(path.join(COVERFLOW_PUBLIC_DIR, safeFileName), buffer);
      await syncFileToDistIfPresent(COVERFLOW_DIST_DIR, safeFileName, buffer);

      // Generate display-optimized WebP derivatives without modifying the original file
      await Promise.allSettled([
        ensureOptimizedCoverflowVariant(safeFileName, 'card'),
        ensureOptimizedCoverflowVariant(safeFileName, 'lightbox'),
      ]);

      res.status(201).json({
        ok: true,
        url: `/images/coverflow/${safeFileName}`,
        optimizedUrl: `/api/media/coverflow/display/${safeFileName}?variant=card`,
        filename: safeFileName,
        sizeBytes: buffer.length,
      });
    } catch (err) {
      console.error('Erro ao salvar imagem da galeria 3D:', err);
      res.status(500).json({ error: 'Não foi possível salvar a imagem no projeto.' });
    }
  }
);

app.delete('/api/media/coverflow/:filename', rateLimit(30, 60_000), async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).json({ error: 'Nome de arquivo inválido.' });
      return;
    }

    // Preserve built-in starter images on disk so demo reset stays intact; delete uploaded foto-* files & optimized cache
    if (filename.startsWith('foto-')) {
      await Promise.all([
        fs.unlink(path.join(COVERFLOW_PUBLIC_DIR, filename)).catch(() => undefined),
        fs.unlink(path.join(COVERFLOW_DIST_DIR, filename)).catch(() => undefined),
        fs.unlink(path.join(COVERFLOW_OPT_PUBLIC_DIR, `${filename}.card.webp`)).catch(() => undefined),
        fs.unlink(path.join(COVERFLOW_OPT_PUBLIC_DIR, `${filename}.lightbox.webp`)).catch(() => undefined),
        fs.unlink(path.join(COVERFLOW_OPT_DIST_DIR, `${filename}.card.webp`)).catch(() => undefined),
        fs.unlink(path.join(COVERFLOW_OPT_DIST_DIR, `${filename}.lightbox.webp`)).catch(() => undefined),
      ]);
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Não foi possível remover o arquivo.' });
  }
});

const CEREMONY_PUBLIC_DIR = path.resolve(__dirname, 'public', 'images', 'ceremony');
const CEREMONY_DIST_DIR = path.resolve(__dirname, 'dist', 'images', 'ceremony');

app.post(
  '/api/media/ceremony',
  rateLimit(30, 60_000),
  express.raw({
    type: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
    limit: '13mb',
  }),
  async (req, res) => {
    try {
      let buffer: Buffer | null = null;
      if (Buffer.isBuffer(req.body)) {
        const contentType = String(req.header('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!ALLOWED_MIME_EXT[contentType]) {
          res.status(400).json({ error: 'Formato de imagem não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = req.body;
      } else {
        const { dataUrl } = (req.body || {}) as { dataUrl?: unknown };
        if (typeof dataUrl !== 'string') {
          res.status(400).json({ error: 'Imagem inválida.' });
          return;
        }
        const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
        if (!match || !ALLOWED_MIME_EXT[match[1].toLowerCase()]) {
          res.status(400).json({ error: 'Formato de imagem não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = Buffer.from(match[2], 'base64');
      }

      if (!buffer || buffer.length === 0 || buffer.length > MAX_COVERFLOW_FILE_BYTES) {
        res.status(400).json({ error: 'A imagem deve ter no máximo 12 MB.' });
        return;
      }

      const metadata = await sharp(buffer).metadata().catch(() => null);
      const verifiedExt = metadata?.format ? ALLOWED_SHARP_FORMATS[metadata.format] : undefined;
      if (!verifiedExt) {
        res.status(400).json({ error: 'Arquivo inválido. Envie uma imagem JPG, PNG ou WEBP íntegra.' });
        return;
      }

      const safeFileName = `ceremony-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${verifiedExt}`;
      await fs.mkdir(CEREMONY_PUBLIC_DIR, { recursive: true });
      await fs.writeFile(path.join(CEREMONY_PUBLIC_DIR, safeFileName), buffer);
      await syncFileToDistIfPresent(CEREMONY_DIST_DIR, safeFileName, buffer);

      res.status(201).json({
        ok: true,
        url: `/images/ceremony/${safeFileName}`,
        filename: safeFileName,
        sizeBytes: buffer.length,
      });
    } catch (err) {
      console.error('Erro ao salvar imagem da cerimônia:', err);
      res.status(500).json({ error: 'Não foi possível salvar a imagem no projeto.' });
    }
  }
);

app.delete('/api/media/ceremony/:filename', rateLimit(30, 60_000), async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).json({ error: 'Nome de arquivo inválido.' });
      return;
    }
    if (filename.startsWith('ceremony-')) {
      await Promise.all([
        fs.unlink(path.join(CEREMONY_PUBLIC_DIR, filename)).catch(() => undefined),
        fs.unlink(path.join(CEREMONY_DIST_DIR, filename)).catch(() => undefined),
      ]);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Não foi possível remover o arquivo.' });
  }
});

const GIFTS_PUBLIC_DIR = path.resolve(__dirname, 'public', 'images', 'gifts');
const GIFTS_DIST_DIR = path.resolve(__dirname, 'dist', 'images', 'gifts');
const GIFTS_OPT_PUBLIC_DIR = path.resolve(GIFTS_PUBLIC_DIR, 'optimized');
const GIFTS_OPT_DIST_DIR = path.resolve(GIFTS_DIST_DIR, 'optimized');
const SRC_ASSETS_IMAGES_DIR = path.resolve(__dirname, 'src', 'assets', 'images');

export interface GiftPhotoSearchResult {
  id: string;
  provider: string;
  commercialName: string;
  brand: string;
  model: string;
  storeName: string;
  referencePriceCents: number | null;
  currency: 'BRL';
  productUrl: string;
  imageUrl: string;
  thumbnailUrl: string;
  licenseNotice: string;
  allowLocalSave: boolean;
  sourceType: 'official_manufacturer' | 'authorized_store' | 'serpapi_shopping';
  width: number;
  height: number;
}

interface VerifiedVtexStore {
  id: string;
  storeName: string;
  baseUrl: string;
  sourceType: 'official_manufacturer' | 'authorized_store';
  brandAliases: string[];
  sectors: Array<'appliances' | 'cookware' | 'tableware' | 'bedding' | 'bath' | 'decor'>;
}

const VERIFIED_BR_STORES: VerifiedVtexStore[] = [
  {
    id: 'mondial',
    storeName: 'Mondial Oficial',
    baseUrl: 'https://www.mondial.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['mondial'],
    sectors: ['appliances'],
  },
  {
    id: 'oster',
    storeName: 'Oster Brasil',
    baseUrl: 'https://www.oster.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['oster'],
    sectors: ['appliances'],
  },
  {
    id: 'electrolux',
    storeName: 'Electrolux Brasil',
    baseUrl: 'https://loja.electrolux.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['electrolux'],
    sectors: ['appliances'],
  },
  {
    id: 'philco',
    storeName: 'Philco Oficial',
    baseUrl: 'https://www.philco.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['philco'],
    sectors: ['appliances'],
  },
  {
    id: 'britania',
    storeName: 'Britânia Oficial',
    baseUrl: 'https://www.britania.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['britania', 'britânia'],
    sectors: ['appliances'],
  },
  {
    id: 'cadence',
    storeName: 'Cadence Oficial',
    baseUrl: 'https://www.cadence.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['cadence'],
    sectors: ['appliances'],
  },
  {
    id: 'arno',
    storeName: 'Arno Oficial',
    baseUrl: 'https://www.arno.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['arno'],
    sectors: ['appliances'],
  },
  {
    id: 'brinox',
    storeName: 'Brinox Shop',
    baseUrl: 'https://www.brinoxshop.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['brinox'],
    sectors: ['cookware', 'tableware'],
  },
  {
    id: 'oxford',
    storeName: 'Oxford Porcelanas',
    baseUrl: 'https://www.oxfordporcelanas.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['oxford', 'biona'],
    sectors: ['tableware', 'cookware', 'decor'],
  },
  {
    id: 'portobrasil',
    storeName: 'Porto Brasil Cerâmica',
    baseUrl: 'https://www.portobrasilceramica.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['porto brasil'],
    sectors: ['tableware', 'decor'],
  },
  {
    id: 'karsten',
    storeName: 'Karsten Oficial',
    baseUrl: 'https://www.karsten.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['karsten', 'trussardi'],
    sectors: ['bedding', 'bath', 'tableware'],
  },
  {
    id: 'altenburg',
    storeName: 'Altenburg Oficial',
    baseUrl: 'https://www.altenburg.com.br',
    sourceType: 'official_manufacturer',
    brandAliases: ['altenburg'],
    sectors: ['bedding', 'bath'],
  },
  {
    id: 'polishop',
    storeName: 'Polishop',
    baseUrl: 'https://www.polishop.com.br',
    sourceType: 'authorized_store',
    brandAliases: ['polishop', 'isha', 'philips walita'],
    sectors: ['appliances', 'cookware'],
  },
  {
    id: 'spicy',
    storeName: 'Spicy',
    baseUrl: 'https://www.spicy.com.br',
    sourceType: 'authorized_store',
    brandAliases: ['spicy', 'cuisinart', 'zwilling', 'kitchenaid'],
    sectors: ['cookware', 'tableware', 'appliances', 'decor'],
  },
  {
    id: 'precolandia',
    storeName: 'Preçolândia',
    baseUrl: 'https://www.precolandia.com.br',
    sourceType: 'authorized_store',
    brandAliases: ['precolandia', 'preçolândia'],
    sectors: ['cookware', 'tableware', 'bedding', 'bath', 'appliances', 'decor'],
  },
];

function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const PT_STOP_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'para',
  'com',
  'sem',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'e',
  'ou',
  'um',
  'uma',
  'os',
  'as',
  'ao',
  'kit',
  'conjunto',
  'jogo',
  'pecas',
]);

function tokenizeNormalized(text: string): string[] {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !PT_STOP_WORDS.has(t));
}

const BLOCKED_COMMERCIAL_IMAGE_RE =
  /watermark|shutterstock|istockphoto|gettyimages|dreamstime|alamy|123rf|depositphotos|vecteezy|ai[- ]?generated|midjourney|dall-e|stable diffusion|diagram|blueprint|\.svg(\?|$)/i;

const SPARE_PART_TERMS = [
  'puxador',
  'alca avulsa',
  'tampa avulsa',
  'cesto',
  'cuba',
  'resistencia',
  'descalcificante',
  'capsula',
  'capsulas',
  'borracha',
  'valvula',
  'vedacao',
  'engrenagem',
  'helice',
  'placa eletronica',
  'reposicao',
  'peca de',
  'capa protetora',
  'suporte avulso',
  'forma de silicone',
  'papel manteiga',
  'fronha avulsa',
  'kit de acessorios',
  'acessorios para',
  'protetor descartavel',
  'descartavel',
];

function isValidHttpUrl(raw?: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function selectStoresForQuery(searchText: string, brandHint: string): VerifiedVtexStore[] {
  const norm = stripAccents(`${searchText} ${brandHint}`).toLowerCase();
  const matchedStores: VerifiedVtexStore[] = [];
  const addStore = (store: VerifiedVtexStore | undefined) => {
    if (store && !matchedStores.some((s) => s.id === store.id)) {
      matchedStores.push(store);
    }
  };

  if (brandHint.trim()) {
    const normBrand = stripAccents(brandHint).toLowerCase();
    for (const store of VERIFIED_BR_STORES) {
      if (store.brandAliases.some((a) => normBrand.includes(a) || a.includes(normBrand))) {
        addStore(store);
      }
    }
  }

  const isAppliance =
    /churrasqueira|air\s*fryer|fritadeira|cafeteira|liquidificador|micro-?ondas|processador|multiprocessador|aspirador|ferro|vaporizador|sanduicheira|grill|purificador|batedeira|torradeira|geladeira|fogao|cooktop|eletro/i.test(
      norm
    );
  const isBeddingBath =
    /jogo de cama|lencol|edredom|manta|colcha|travesseiro|protetor|toalha de banho|toalha de rosto|toalha de mesa|tapete|banheiro|roupao|fronha|fronhas/i.test(
      norm
    );
  const isTableware =
    /aparelho de jantar|prato|pratos|taca|tacas|copo|copos|jarra|xicara|xicaras|faqueiro|talher|talheres|saladeira|tigela|petisqueira|jogo americano|travessa/i.test(
      norm
    );
  const isCookware =
    /panela|panelas|frigideira|pressao|assadeira|assareira|forma|utensilio|escorredor|chaleira|fervedor|faca|tabua|pote|hermetico/i.test(
      norm
    );

  if (isAppliance) {
    ['mondial', 'oster', 'electrolux', 'philco', 'britania', 'cadence', 'arno', 'polishop', 'precolandia'].forEach(
      (id) => addStore(VERIFIED_BR_STORES.find((s) => s.id === id))
    );
  }
  if (isBeddingBath) {
    ['karsten', 'altenburg', 'precolandia'].forEach((id) =>
      addStore(VERIFIED_BR_STORES.find((s) => s.id === id))
    );
  }
  if (isTableware) {
    ['oxford', 'portobrasil', 'brinox', 'spicy', 'precolandia'].forEach((id) =>
      addStore(VERIFIED_BR_STORES.find((s) => s.id === id))
    );
  }
  if (isCookware) {
    ['brinox', 'spicy', 'precolandia', 'oxford', 'polishop'].forEach((id) =>
      addStore(VERIFIED_BR_STORES.find((s) => s.id === id))
    );
  }

  if (matchedStores.length === 0) {
    ['precolandia', 'spicy', 'brinox', 'oxford', 'karsten', 'mondial', 'oster', 'polishop'].forEach((id) =>
      addStore(VERIFIED_BR_STORES.find((s) => s.id === id))
    );
  }

  return matchedStores.slice(0, 7);
}

interface VtexProductRaw {
  productId?: string;
  productName?: string;
  productTitle?: string;
  brand?: string;
  productReference?: string;
  link?: string;
  linkText?: string;
  items?: Array<{
    itemId?: string;
    name?: string;
    referenceId?: Array<{ Key?: string; Value?: string }>;
    images?: Array<{ imageUrl?: string; imageText?: string }>;
    sellers?: Array<{
      commertialOffer?: {
        Price?: number;
        ListPrice?: number;
        AvailableQuantity?: number;
        IsAvailable?: boolean;
      };
    }>;
  }>;
}

function extractVtexModel(product: VtexProductRaw): string {
  const ref = (product.productReference || '').trim();
  if (ref && ref.length >= 2 && ref.length <= 40 && !/^default$/i.test(ref)) {
    return ref;
  }
  const firstSku = product.items?.[0];
  const skuRef = firstSku?.referenceId?.find((r) => r.Value?.trim())?.Value?.trim();
  if (skuRef && skuRef.length >= 2 && skuRef.length <= 40) {
    return skuRef;
  }
  const name = product.productName || '';
  const codeMatch = /\b([A-Z]{1,4}-?\d{2,4}(?:-[A-Z0-9]{1,4})?)\b/.exec(name);
  if (codeMatch) return codeMatch[1];
  return '';
}

function scoreCommercialProductCandidate(
  candidate: GiftPhotoSearchResult,
  fullQuery: string,
  primaryName: string,
  brandHint: string
): number {
  const normQuery = stripAccents(primaryName || fullQuery).toLowerCase();
  const normFullQuery = stripAccents(fullQuery).toLowerCase();
  const normTitle = stripAccents(candidate.commercialName).toLowerCase();
  const normBrand = stripAccents(candidate.brand).toLowerCase();
  const normModel = stripAccents(candidate.model).toLowerCase();

  // Reject spare parts and unrelated accessories unless explicitly requested
  for (const term of SPARE_PART_TERMS) {
    if (normTitle.includes(term) && !normFullQuery.includes(term)) {
      return -1000;
    }
  }

  // Specific appliance/category mismatch guards
  if (normQuery.includes('churrasqueira') && normQuery.includes('eletric')) {
    if (!normTitle.includes('churrasqueira')) return -500;
    if (/\b(carvao|a gas|lenha|bafo)\b/.test(normTitle) && !normTitle.includes('eletric')) {
      return -500;
    }
  }
  if (/air\s*fryer/.test(normQuery)) {
    if (!/air\s*fryer|fritadeira/.test(normTitle)) return -500;
  }
  if (normQuery.includes('aparelho de jantar')) {
    if (!normTitle.includes('aparelho de jantar') && !normTitle.includes('conjunto de pratos')) {
      return -200;
    }
  }
  if (normQuery.includes('jogo de panelas')) {
    if (!normTitle.includes('panela')) return -300;
    if (/^\s*(tampa|cabo|frigideira\b)/.test(normTitle) && !normTitle.includes('jogo') && !normTitle.includes('conjunto')) {
      return -200;
    }
  }
  if (normQuery.includes('jogo de cama')) {
    if (!normTitle.includes('jogo de cama') && !normTitle.includes('jogo de lencol') && !normTitle.includes('lencol')) {
      return -200;
    }
  }
  if (normQuery.includes('cafeteira')) {
    if (!normTitle.includes('cafeteira')) return -300;
  }

  const queryTokens = tokenizeNormalized(primaryName || fullQuery);
  const fullTokens = tokenizeNormalized(fullQuery);
  const targetText = `${normTitle} ${normBrand} ${normModel}`;

  if (queryTokens.length === 0) return -100;

  let primaryHits = 0;
  for (const tok of queryTokens) {
    if (targetText.includes(tok)) {
      primaryHits += 1;
    }
  }

  // Require strong core overlap with the product name
  const overlapRatio = primaryHits / queryTokens.length;
  if (primaryHits === 0 || (queryTokens.length >= 2 && overlapRatio < 0.5)) {
    return -100;
  }

  let score = Math.round(overlapRatio * 60);

  if (normTitle.includes(normQuery)) {
    score += 35;
  }

  for (const tok of fullTokens) {
    if (targetText.includes(tok)) {
      score += 8;
    }
  }

  if (brandHint.trim()) {
    const bHint = stripAccents(brandHint).toLowerCase();
    if (normBrand.includes(bHint) || normTitle.includes(bHint)) {
      score += 25;
    }
  }

  if (candidate.sourceType === 'official_manufacturer') score += 12;
  if (candidate.model) score += 8;
  if (candidate.referencePriceCents && candidate.referencePriceCents > 0) score += 8;

  return score;
}

async function searchVerifiedVtexStore(
  store: VerifiedVtexStore,
  query: string,
  externalSignal?: AbortSignal
): Promise<GiftPhotoSearchResult[]> {
  const url = `${store.baseUrl}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}&_from=0&_to=7`;
  const timeoutSignal = AbortSignal.timeout(4500);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'DalmoEJadiGiftCurator/2.0 (+https://dalmoejadi.com)',
    },
    signal,
  });

  if (!res.ok) return [];
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) return [];

  const results: GiftPhotoSearchResult[] = [];
  for (const item of raw as VtexProductRaw[]) {
    const commercialName = (item.productName || item.productTitle || '').trim();
    const brand = (item.brand || '').trim();
    const firstSku = item.items?.[0];
    const imageUrl = firstSku?.images?.[0]?.imageUrl?.trim() || '';
    const productUrl =
      item.link && item.link.startsWith('https://')
        ? item.link
        : item.linkText
          ? `${store.baseUrl}/${item.linkText.replace(/^\//, '')}/p`
          : '';

    if (!commercialName || !brand || /^generico$/i.test(stripAccents(brand))) continue;
    if (!isValidHttpUrl(productUrl) || !isValidHttpUrl(imageUrl)) continue;
    if (BLOCKED_COMMERCIAL_IMAGE_RE.test(`${commercialName} ${imageUrl}`)) continue;

    const firstOffer = firstSku?.sellers?.[0]?.commertialOffer;
    const rawPrice =
      typeof firstOffer?.Price === 'number' && firstOffer.Price > 0
        ? firstOffer.Price
        : typeof firstOffer?.ListPrice === 'number' && firstOffer.ListPrice > 0
          ? firstOffer.ListPrice
          : null;

    const model = extractVtexModel(item);

    results.push({
      id: `${store.id}-${item.productId || firstSku?.itemId || results.length}`,
      provider: store.storeName,
      commercialName: commercialName.slice(0, 140),
      brand: brand.slice(0, 60),
      model: model.slice(0, 45),
      storeName: store.storeName,
      referencePriceCents: rawPrice ? Math.round(rawPrice * 100) : null,
      currency: 'BRL',
      productUrl,
      imageUrl,
      thumbnailUrl: imageUrl,
      licenseNotice:
        store.sourceType === 'official_manufacturer'
          ? 'Catálogo oficial do fabricante — registro por URL comercial verificada.'
          : 'Catálogo oficial da loja parceira — registro por URL comercial verificada.',
      allowLocalSave: false,
      sourceType: store.sourceType,
      width: 1000,
      height: 1000,
    });
  }

  return results;
}

function parseBRLPriceToCents(rawPrice?: string, extractedPrice?: number): number | null {
  if (typeof extractedPrice === 'number' && Number.isFinite(extractedPrice) && extractedPrice > 0) {
    return Math.round(extractedPrice * 100);
  }
  if (!rawPrice) return null;
  const cleaned = rawPrice.replace(/[^\d,]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

async function searchSerpApiShoppingProducts(
  query: string,
  externalSignal?: AbortSignal
): Promise<GiftPhotoSearchResult[]> {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  if (!apiKey) return [];
  const timeoutSignal = AbortSignal.timeout(5500);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(
    `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&gl=br&hl=pt&num=8&api_key=${encodeURIComponent(apiKey)}`,
    { signal }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    shopping_results?: Array<{
      position?: number;
      title?: string;
      link?: string;
      product_link?: string;
      source?: string;
      thumbnail?: string;
      price?: string;
      extracted_price?: number;
    }>;
  };

  return (data.shopping_results || [])
    .filter((p) => {
      const pUrl = p.link || p.product_link || '';
      return (
        Boolean(p.title?.trim()) &&
        Boolean(p.source?.trim()) &&
        isValidHttpUrl(pUrl) &&
        isValidHttpUrl(p.thumbnail) &&
        !BLOCKED_COMMERCIAL_IMAGE_RE.test(`${p.title || ''} ${p.thumbnail || ''}`)
      );
    })
    .map((p, idx) => ({
      id: `serpapi-${p.position || idx}-${Date.now()}`,
      provider: 'Google Shopping API',
      commercialName: (p.title || '').trim().slice(0, 140),
      brand: (p.source || 'Marca comercial').trim().slice(0, 60),
      model: '',
      storeName: (p.source || 'Loja verificada').trim().slice(0, 60),
      referencePriceCents: parseBRLPriceToCents(p.price, p.extracted_price),
      currency: 'BRL' as const,
      productUrl: p.link || p.product_link || '',
      imageUrl: p.thumbnail || '',
      thumbnailUrl: p.thumbnail || '',
      licenseNotice: 'URL comercial via Google Shopping API — registro por link autorizado.',
      allowLocalSave: false,
      sourceType: 'serpapi_shopping' as const,
      width: 800,
      height: 800,
    }));
}

function isPrivateIpAddress(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/i, '').toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  ) {
    return true;
  }
  const parts = normalized.split('.').map((n) => Number(n));
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  return false;
}

async function assertSafeRemoteImageUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL de imagem inválida.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Somente URLs HTTPS seguras são permitidas.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Porta não permitida.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Destino de rede interno bloqueado.');
  }
  if (net.isIP(host) && isPrivateIpAddress(host)) {
    throw new Error('Endereço IP privado bloqueado.');
  }
  const resolved = await dns.lookup(host, { all: true }).catch(() => []);
  if (!resolved.length || resolved.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error('Não foi possível validar o endereço público da imagem.');
  }
  return parsed;
}

async function fetchSafeRemoteImageBuffer(initialUrl: string): Promise<Buffer> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    await assertSafeRemoteImageUrl(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'DalmoEJadiGiftCurator/2.0',
        Accept: 'image/webp,image/jpeg,image/png,image/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirecionamento sem destino.');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`Falha ao baixar a imagem (HTTP ${response.status}).`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0 || buffer.length > MAX_COVERFLOW_FILE_BYTES) {
      throw new Error('A imagem excede o limite de 12 MB.');
    }
    return buffer;
  }
  throw new Error('Excesso de redirecionamentos ao baixar a imagem.');
}

async function ensureOptimizedGiftVariant(
  filename: string,
  variant: 'desktop' | 'mobile',
  format: 'webp' | 'avif'
): Promise<string | null> {
  const safeName = path.basename(filename);
  if (!/^[a-zA-Z0-9._-]+$/.test(safeName)) return null;

  const optFileName = `${safeName}.${variant}.${format}`;
  const publicOptPath = path.join(GIFTS_OPT_PUBLIC_DIR, optFileName);
  const publicOptExists = await fs
    .stat(publicOptPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (publicOptExists) return publicOptPath;

  const distOptPath = path.join(GIFTS_OPT_DIST_DIR, optFileName);
  const distOptExists = await fs
    .stat(distOptPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (distOptExists) return distOptPath;

  const publicOrigPath = path.join(GIFTS_PUBLIC_DIR, safeName);
  const distOrigPath = path.join(GIFTS_DIST_DIR, safeName);
  const sourcePath =
    (await fs
      .stat(publicOrigPath)
      .then((s) => (s.isFile() ? publicOrigPath : null))
      .catch(() => null)) ||
    (await fs
      .stat(distOrigPath)
      .then((s) => (s.isFile() ? distOrigPath : null))
      .catch(() => null));

  if (!sourcePath) return null;

  const width = variant === 'mobile' ? 480 : 800;
  const height = variant === 'mobile' ? 360 : 600;

  await fs.mkdir(GIFTS_OPT_PUBLIC_DIR, { recursive: true });
  const pipeline = sharp(sourcePath)
    .rotate()
    .resize({ width, height, fit: 'cover', position: 'centre' });

  if (format === 'avif') {
    await pipeline.avif({ quality: variant === 'mobile' ? 60 : 64, effort: 4 }).toFile(publicOptPath);
  } else {
    await pipeline.webp({ quality: variant === 'mobile' ? 82 : 85, effort: 4 }).toFile(publicOptPath);
  }

  await syncFileToDistIfPresent(GIFTS_OPT_DIST_DIR, optFileName, publicOptPath);
  return publicOptPath;
}

const giftPhotoSearchCache = new Map<
  string,
  {
    expiresAt: number;
    payload: {
      ok: true;
      rawQuery: string;
      effectiveQuery: string;
      providersUsed: string[];
      results: GiftPhotoSearchResult[];
    };
  }
>();

app.get('/api/gifts/photo-search', rateLimit(40, 60_000), async (req, res) => {
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const rawQuery = String(req.query.q || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const brandHint = String(req.query.brand || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const modelHint = String(req.query.model || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const typeHint = String(req.query.type || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const extraHint = String(req.query.extra || '').trim().replace(/\s+/g, ' ').slice(0, 60);

    if (!rawQuery) {
      res.status(400).json({ error: 'Informe o nome do produto ou termo de pesquisa.' });
      return;
    }

    const effectiveQuery = [rawQuery, brandHint, modelHint, typeHint, extraHint]
      .filter(Boolean)
      .join(' ')
      .trim()
      .slice(0, 180);

    const forceFresh = req.query.fresh === '1';
    const cacheKey = `${effectiveQuery.toLowerCase()}::${brandHint.toLowerCase()}`;
    const cached = !forceFresh ? giftPhotoSearchCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.payload);
      return;
    }

    const stores = selectStoresForQuery(effectiveQuery, brandHint);
    const storeTasks = stores.map((store) =>
      searchVerifiedVtexStore(store, effectiveQuery, abortController.signal)
    );
    const allTasks = [searchSerpApiShoppingProducts(effectiveQuery, abortController.signal), ...storeTasks];

    const settled = await Promise.allSettled(allTasks);
    if (abortController.signal.aborted) return;

    const scoredCandidates: Array<{ item: GiftPhotoSearchResult; score: number }> = [];
    const seenUrls = new Set<string>();
    const seenNames = new Set<string>();

    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      for (const item of outcome.value) {
        const imgKey = item.imageUrl.split('?')[0].toLowerCase();
        const nameKey = stripAccents(item.commercialName).toLowerCase();
        if (seenUrls.has(imgKey) || seenNames.has(nameKey)) continue;

        const score = scoreCommercialProductCandidate(item, effectiveQuery, rawQuery, brandHint);
        if (score < 35) continue;

        seenUrls.add(imgKey);
        seenNames.add(nameKey);
        scoredCandidates.push({ item, score });
      }
    }

    scoredCandidates.sort((a, b) => b.score - a.score);

    // Strictly cap at 4 verified commercial products (preferring brand diversity)
    const topResults: GiftPhotoSearchResult[] = [];
    const brandCounts = new Map<string, number>();

    for (const entry of scoredCandidates) {
      const bKey = stripAccents(entry.item.brand).toLowerCase();
      const count = brandCounts.get(bKey) || 0;
      if (count >= 2 && scoredCandidates.length > 4) continue;
      brandCounts.set(bKey, count + 1);
      topResults.push(entry.item);
      if (topResults.length >= 4) break;
    }

    if (topResults.length < 4) {
      for (const entry of scoredCandidates) {
        if (!topResults.some((r) => r.id === entry.item.id)) {
          topResults.push(entry.item);
          if (topResults.length >= 4) break;
        }
      }
    }

    const providersUsed = Array.from(new Set(topResults.map((r) => r.storeName)));

    const payload = {
      ok: true as const,
      rawQuery,
      effectiveQuery,
      providersUsed,
      results: topResults,
    };

    if (topResults.length > 0) {
      giftPhotoSearchCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60_000,
        payload,
      });
    }

    res.json(payload);
  } catch (err) {
    if (abortController.signal.aborted) return;
    console.error('Erro na busca de produtos comerciais:', err);
    res.status(500).json({ error: 'Não foi possível consultar as APIs comerciais no momento.' });
  }
});

app.get('/api/media/gifts/display/:filename', async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).json({ error: 'Nome de arquivo inválido.' });
      return;
    }

    const variant: 'desktop' | 'mobile' = req.query.variant === 'mobile' ? 'mobile' : 'desktop';
    const acceptHeader = String(req.headers.accept || '');
    const requestedFormat =
      req.query.format === 'avif'
        ? 'avif'
        : req.query.format === 'webp'
          ? 'webp'
          : acceptHeader.includes('image/avif')
            ? 'avif'
            : 'webp';

    try {
      const optimizedPath = await ensureOptimizedGiftVariant(filename, variant, requestedFormat);
      if (optimizedPath) {
        res.setHeader('Content-Type', requestedFormat === 'avif' ? 'image/avif' : 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(optimizedPath);
        return;
      }
    } catch (optErr) {
      console.warn('Fallback para imagem original do presente:', optErr);
    }

    const publicOrigPath = path.join(GIFTS_PUBLIC_DIR, filename);
    const hasPublicOrig = await fs
      .stat(publicOrigPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (hasPublicOrig) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(publicOrigPath);
      return;
    }

    res.status(404).json({ error: 'Imagem não encontrada.' });
  } catch (err) {
    console.error('Erro ao servir imagem otimizada do presente:', err);
    res.status(500).json({ error: 'Não foi possível carregar a imagem.' });
  }
});

app.post('/api/media/gifts/import', rateLimit(30, 60_000), async (req, res) => {
  try {
    const { url, title, allowLocalSave } = (req.body || {}) as {
      url?: unknown;
      title?: unknown;
      allowLocalSave?: unknown;
    };

    if (allowLocalSave !== true) {
      res.status(400).json({
        error: 'Este produto exige preservação por URL comercial autorizada (sem cópia local).',
      });
      return;
    }

    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'URL da imagem ausente.' });
      return;
    }

    const rawBuffer = await fetchSafeRemoteImageBuffer(url.trim());
    const metadata = await sharp(rawBuffer).metadata().catch(() => null);
    const verifiedExt = metadata?.format ? ALLOWED_SHARP_FORMATS[metadata.format] : undefined;
    if (!verifiedExt || !metadata?.width || metadata.width < 250) {
      res.status(400).json({ error: 'Arquivo remoto inválido ou resolução insuficiente.' });
      return;
    }

    const optimizedBuffer = await sharp(rawBuffer)
      .rotate()
      .resize({ width: 800, height: 600, fit: 'cover', position: 'centre' })
      .webp({ quality: 86, effort: 4 })
      .toBuffer();

    const slug =
      stripAccents(typeof title === 'string' ? title : 'presente')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32) || 'presente';

    const safeFileName = `gift-${slug}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
    await fs.mkdir(GIFTS_PUBLIC_DIR, { recursive: true });
    await fs.writeFile(path.join(GIFTS_PUBLIC_DIR, safeFileName), optimizedBuffer);
    await syncFileToDistIfPresent(GIFTS_DIST_DIR, safeFileName, optimizedBuffer);

    await Promise.allSettled([
      ensureOptimizedGiftVariant(safeFileName, 'desktop', 'webp'),
      ensureOptimizedGiftVariant(safeFileName, 'desktop', 'avif'),
      ensureOptimizedGiftVariant(safeFileName, 'mobile', 'webp'),
      ensureOptimizedGiftVariant(safeFileName, 'mobile', 'avif'),
    ]);

    res.status(201).json({
      ok: true,
      url: `/images/gifts/${safeFileName}`,
      optimizedUrl: `/api/media/gifts/display/${safeFileName}`,
      filename: safeFileName,
      sizeBytes: optimizedBuffer.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Não foi possível importar a imagem.';
    console.error('Erro ao importar imagem do presente:', err);
    res.status(400).json({ error: message });
  }
});

app.post(
  '/api/media/gifts',
  rateLimit(30, 60_000),
  express.raw({
    type: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
    limit: '13mb',
  }),
  async (req, res) => {
    try {
      let buffer: Buffer | null = null;
      if (Buffer.isBuffer(req.body)) {
        const contentType = String(req.header('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!ALLOWED_MIME_EXT[contentType]) {
          res.status(400).json({ error: 'Formato não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = req.body;
      } else {
        const { dataUrl } = (req.body || {}) as { dataUrl?: unknown };
        if (typeof dataUrl !== 'string') {
          res.status(400).json({ error: 'Imagem inválida.' });
          return;
        }
        const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
        if (!match || !ALLOWED_MIME_EXT[match[1].toLowerCase()]) {
          res.status(400).json({ error: 'Formato não suportado. Use JPG, PNG ou WEBP.' });
          return;
        }
        buffer = Buffer.from(match[2], 'base64');
      }

      if (!buffer || buffer.length === 0 || buffer.length > MAX_COVERFLOW_FILE_BYTES) {
        res.status(400).json({ error: 'A imagem deve ter no máximo 12 MB.' });
        return;
      }

      const metadata = await sharp(buffer).metadata().catch(() => null);
      const verifiedExt = metadata?.format ? ALLOWED_SHARP_FORMATS[metadata.format] : undefined;
      if (!verifiedExt) {
        res.status(400).json({ error: 'Arquivo inválido. Envie uma imagem JPG, PNG ou WEBP íntegra.' });
        return;
      }

      // Generate optimized 4:3 WebP master (800x600) + AVIF/WebP responsive derivatives
      const optimizedWebpMaster = await sharp(buffer)
        .rotate()
        .resize({ width: 800, height: 600, fit: 'cover', position: 'centre' })
        .webp({ quality: 86, effort: 4 })
        .toBuffer();

      const safeFileName = `gift-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
      await fs.mkdir(GIFTS_PUBLIC_DIR, { recursive: true });
      await fs.writeFile(path.join(GIFTS_PUBLIC_DIR, safeFileName), optimizedWebpMaster);
      await syncFileToDistIfPresent(GIFTS_DIST_DIR, safeFileName, optimizedWebpMaster);

      await Promise.allSettled([
        ensureOptimizedGiftVariant(safeFileName, 'desktop', 'webp'),
        ensureOptimizedGiftVariant(safeFileName, 'desktop', 'avif'),
        ensureOptimizedGiftVariant(safeFileName, 'mobile', 'webp'),
        ensureOptimizedGiftVariant(safeFileName, 'mobile', 'avif'),
      ]);

      res.status(201).json({
        ok: true,
        url: `/images/gifts/${safeFileName}`,
        optimizedUrl: `/api/media/gifts/display/${safeFileName}`,
        filename: safeFileName,
        sizeBytes: optimizedWebpMaster.length,
      });
    } catch (err) {
      console.error('Erro ao salvar upload manual do presente:', err);
      res.status(500).json({ error: 'Não foi possível salvar a imagem no projeto.' });
    }
  }
);

async function readStaticImportFilenames(tsFilePath: string): Promise<Set<string>> {
  const filenames = new Set<string>();
  try {
    const content = await fs.readFile(tsFilePath, 'utf-8');
    const importRegex = /from\s+['"]\.\.\/assets\/images\/([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      filenames.add(path.basename(match[1]));
    }
  } catch {
    // ignore missing file
  }
  return filenames;
}

interface LegacyGalleryFileItem {
  id: string;
  filename: string;
  location: 'src_assets' | 'public_gifts';
  previewUrl: string;
  sizeBytes: number;
  deletable: boolean;
  statusLabel: string;
  inUseReason: string | null;
}

async function scanLegacyGiftGallery(activeImageUrls: string[] = []): Promise<{
  items: LegacyGalleryFileItem[];
  summary: {
    totalScanned: number;
    deletableCount: number;
    inUseArtificialCount: number;
    protectedSectionCount: number;
  };
}> {
  const assetsTsImports = await readStaticImportFilenames(
    path.resolve(__dirname, 'src', 'data', 'assets.ts')
  );
  const giftImagesTsImports = await readStaticImportFilenames(
    path.resolve(__dirname, 'src', 'data', 'giftImages.ts')
  );

  const normalizedActiveUrls = new Set(
    activeImageUrls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map((u) => u.trim())
  );

  const items: LegacyGalleryFileItem[] = [];
  let protectedSectionCount = 0;

  // 1. Scan src/assets/images for artificial gift_*.jpg files (never touch real_gift_* or assets.ts files)
  const assetEntries = await fs.readdir(SRC_ASSETS_IMAGES_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of assetEntries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    if (assetsTsImports.has(filename)) {
      protectedSectionCount += 1;
      continue;
    }
    if (filename.startsWith('real_gift_')) {
      continue;
    }
    if (!/^gift_.+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
      continue;
    }

    const filePath = path.join(SRC_ASSETS_IMAGES_DIR, filename);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;

    const bundledStatic = giftImagesTsImports.has(filename);
    const inActiveGiftUrl = Array.from(normalizedActiveUrls).some((url) => url.includes(filename));
    const inUse = bundledStatic || inActiveGiftUrl;

    items.push({
      id: `src_assets:${filename}`,
      filename,
      location: 'src_assets',
      previewUrl: `/api/media/gifts/legacy-preview/${encodeURIComponent(filename)}`,
      sizeBytes: stat.size,
      deletable: !inUse,
      statusLabel: inUse ? 'Em uso no catálogo — substitua antes de excluir' : 'Arquivo antigo não utilizado',
      inUseReason: bundledStatic
        ? 'Substituir foto artificial em uso pelo catálogo padrão'
        : inActiveGiftUrl
          ? 'Em uso por presente ativo no banco de dados'
          : null,
    });
  }

  // 2. Scan public/images/gifts for unused uploaded/imported gift images
  const publicGiftEntries = await fs.readdir(GIFTS_PUBLIC_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of publicGiftEntries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    if (!/\.(jpg|jpeg|png|webp|avif)$/i.test(filename)) continue;

    const filePath = path.join(GIFTS_PUBLIC_DIR, filename);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;

    const expectedPath = `/images/gifts/${filename}`;
    const inUse = Array.from(normalizedActiveUrls).some(
      (url) => url.includes(expectedPath) || url.includes(filename)
    );

    items.push({
      id: `public_gifts:${filename}`,
      filename,
      location: 'public_gifts',
      previewUrl: expectedPath,
      sizeBytes: stat.size,
      deletable: !inUse,
      statusLabel: inUse ? 'Em uso por presente cadastrado' : 'Upload antigo não utilizado',
      inUseReason: inUse ? 'Associada a um presente ativo do catálogo' : null,
    });
  }

  items.sort((a, b) => {
    if (a.deletable !== b.deletable) return a.deletable ? -1 : 1;
    return a.filename.localeCompare(b.filename);
  });

  return {
    items,
    summary: {
      totalScanned: items.length,
      deletableCount: items.filter((i) => i.deletable).length,
      inUseArtificialCount: items.filter((i) => !i.deletable).length,
      protectedSectionCount,
    },
  };
}

app.get('/api/media/gifts/legacy-preview/:filename', async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^gift_[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
      res.status(400).json({ error: 'Prévia não autorizada.' });
      return;
    }
    const assetsTsImports = await readStaticImportFilenames(
      path.resolve(__dirname, 'src', 'data', 'assets.ts')
    );
    if (assetsTsImports.has(filename)) {
      res.status(403).json({ error: 'Arquivo protegido de outra seção.' });
      return;
    }
    const targetPath = path.join(SRC_ASSETS_IMAGES_DIR, filename);
    const exists = await fs
      .stat(targetPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists) {
      res.status(404).json({ error: 'Arquivo não encontrado.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(targetPath);
  } catch {
    res.status(500).json({ error: 'Falha ao carregar prévia.' });
  }
});

app.get('/api/media/gifts/legacy-gallery', rateLimit(30, 60_000), async (_req, res) => {
  try {
    const result = await scanLegacyGiftGallery([]);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Erro ao listar galeria antiga:', err);
    res.status(500).json({ error: 'Não foi possível inspecionar a galeria antiga.' });
  }
});

app.post('/api/media/gifts/legacy-scan', rateLimit(30, 60_000), async (req, res) => {
  try {
    const { activeImageUrls } = (req.body || {}) as { activeImageUrls?: unknown };
    const urls = Array.isArray(activeImageUrls) ? (activeImageUrls as string[]) : [];
    const result = await scanLegacyGiftGallery(urls);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Erro ao analisar galeria antiga:', err);
    res.status(500).json({ error: 'Não foi possível analisar a galeria antiga.' });
  }
});

app.post('/api/media/gifts/legacy-delete', rateLimit(20, 60_000), async (req, res) => {
  try {
    const { items, confirmed, activeImageUrls } = (req.body || {}) as {
      items?: Array<{ filename?: unknown; location?: unknown }>;
      confirmed?: unknown;
      activeImageUrls?: unknown;
    };

    if (confirmed !== true) {
      res.status(400).json({ error: 'Confirmação explícita obrigatória antes da exclusão.' });
      return;
    }

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Selecione ao menos um arquivo para exclusão.' });
      return;
    }

    const scanResult = await scanLegacyGiftGallery(
      Array.isArray(activeImageUrls) ? (activeImageUrls as string[]) : []
    );
    const allowedMap = new Map(
      scanResult.items.map((item) => [`${item.location}:${item.filename}`, item])
    );

    const deletedFiles: string[] = [];
    const skipped: Array<{ filename: string; reason: string }> = [];

    for (const rawEntry of items) {
      const filename = path.basename(String(rawEntry?.filename || ''));
      const location = rawEntry?.location === 'public_gifts' ? 'public_gifts' : 'src_assets';
      const entry = allowedMap.get(`${location}:${filename}`);

      if (!entry) {
        skipped.push({ filename, reason: 'Arquivo protegido ou não listado como legado.' });
        continue;
      }
      if (!entry.deletable) {
        skipped.push({
          filename,
          reason: entry.inUseReason || 'Arquivo em uso; substitua antes de excluir.',
        });
        continue;
      }

      if (location === 'src_assets') {
        await fs.unlink(path.join(SRC_ASSETS_IMAGES_DIR, filename)).catch(() => undefined);
      } else {
        await Promise.all([
          fs.unlink(path.join(GIFTS_PUBLIC_DIR, filename)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_DIST_DIR, filename)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.desktop.webp`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.desktop.avif`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.mobile.webp`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.mobile.avif`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_DIST_DIR, `${filename}.desktop.webp`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_DIST_DIR, `${filename}.desktop.avif`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_DIST_DIR, `${filename}.mobile.webp`)).catch(() => undefined),
          fs.unlink(path.join(GIFTS_OPT_DIST_DIR, `${filename}.mobile.avif`)).catch(() => undefined),
        ]);
      }
      deletedFiles.push(filename);
    }

    res.json({
      ok: true,
      deletedCount: deletedFiles.length,
      deletedFiles,
      skipped,
    });
  } catch (err) {
    console.error('Erro ao excluir arquivos da galeria antiga:', err);
    res.status(500).json({ error: 'Não foi possível concluir a limpeza da galeria antiga.' });
  }
});

app.delete('/api/media/gifts/:filename', rateLimit(30, 60_000), async (req, res) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).json({ error: 'Nome de arquivo inválido.' });
      return;
    }
    if (filename.startsWith('gift-')) {
      await Promise.all([
        fs.unlink(path.join(GIFTS_PUBLIC_DIR, filename)).catch(() => undefined),
        fs.unlink(path.join(GIFTS_DIST_DIR, filename)).catch(() => undefined),
        fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.desktop.webp`)).catch(() => undefined),
        fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.desktop.avif`)).catch(() => undefined),
        fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.mobile.webp`)).catch(() => undefined),
        fs.unlink(path.join(GIFTS_OPT_PUBLIC_DIR, `${filename}.mobile.avif`)).catch(() => undefined),
      ]);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Não foi possível remover o arquivo.' });
  }
});

// Return clean JSON errors for oversized payloads (e.g. > 12 MB uploads)
app.use((err: { type?: string; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    res.status(413).json({ error: 'A imagem deve ter no máximo 12 MB.' });
    return;
  }
  next(err);
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    webhookConfigured: Boolean(process.env.PIX_WEBHOOK_SECRET),
    serviceAccountConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
  });
});

interface FirebaseWebConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

let cachedFirebaseWebConfig: FirebaseWebConfig | null = null;
let cachedSecureTokenCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getFirebaseWebConfig(): Promise<FirebaseWebConfig> {
  if (cachedFirebaseWebConfig) return cachedFirebaseWebConfig;
  const raw = await fs.readFile(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<FirebaseWebConfig>;
  if (!parsed.projectId || !parsed.firestoreDatabaseId) {
    throw new Error('Configuração do Firebase ausente no servidor.');
  }
  cachedFirebaseWebConfig = {
    projectId: parsed.projectId,
    apiKey: parsed.apiKey || '',
    firestoreDatabaseId: parsed.firestoreDatabaseId,
  };
  return cachedFirebaseWebConfig;
}

async function getSecureTokenCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && cachedSecureTokenCerts && cachedSecureTokenCerts.expiresAt > now) {
    return cachedSecureTokenCerts.certs;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout(8000) }
  );
  if (!resp.ok) {
    throw new Error('Falha ao obter chaves públicas de autenticação.');
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const maxAgeSec = maxAgeMatch ? Math.max(60, Number.parseInt(maxAgeMatch[1], 10)) : 3600;
  cachedSecureTokenCerts = {
    certs,
    expiresAt: now + maxAgeSec * 1000,
  };
  return certs;
}

class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function verifyAuthenticatedAdminRequest(
  authHeader: string
): Promise<{ uid: string; email: string; idToken: string; config: FirebaseWebConfig }> {
  const match = /^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(
    authHeader.trim()
  );
  if (!match) {
    throw new HttpStatusError(401, 'Autenticação administrativa obrigatória.');
  }
  const idToken = match[1];
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new HttpStatusError(401, 'Token de autenticação inválido.');
  }

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
  };
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new HttpStatusError(401, 'Token de autenticação malformado.');
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new HttpStatusError(401, 'Assinatura de token não suportada.');
  }

  const config = await getFirebaseWebConfig();
  let certs = await getSecureTokenCerts(false);
  let pemCert = certs[header.kid];
  if (!pemCert) {
    certs = await getSecureTokenCerts(true);
    pemCert = certs[header.kid];
  }
  if (!pemCert) {
    throw new HttpStatusError(401, 'Chave de verificação do token não encontrada.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const signatureValid = verifier.verify(pemCert, Buffer.from(parts[2], 'base64url'));
  if (!signatureValid) {
    throw new HttpStatusError(401, 'Assinatura do token de sessão inválida.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (
    payload.aud !== config.projectId ||
    payload.iss !== `https://securetoken.google.com/${config.projectId}` ||
    typeof payload.sub !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub) ||
    typeof payload.exp !== 'number' ||
    payload.exp <= nowSec ||
    typeof payload.iat !== 'number' ||
    payload.iat > nowSec + 300
  ) {
    throw new HttpStatusError(401, 'Sessão expirada ou inválida. Faça login novamente.');
  }

  if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email) {
    throw new HttpStatusError(403, 'E-mail administrativo não verificado.');
  }

  const normalizedEmail = payload.email.trim().toLowerCase();
  const isBootstrapAdmin = normalizedEmail === 'dalmofilho38@gmail.com';
  if (!isBootstrapAdmin) {
    const adminDocUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/${config.firestoreDatabaseId}/documents/admins/${encodeURIComponent(payload.sub)}`;
    const adminRes = await fetch(adminDocUrl, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!adminRes.ok) {
      throw new HttpStatusError(
        403,
        'Acesso negado: apenas administradores autenticados podem excluir registros.'
      );
    }
  }

  return {
    uid: payload.sub,
    email: payload.email.trim(),
    idToken,
    config,
  };
}

interface FirestoreFieldValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
}

function readFirestoreString(
  fields: Record<string, FirestoreFieldValue> | undefined,
  key: string
): string {
  const val = fields?.[key]?.stringValue;
  return typeof val === 'string' ? val : '';
}

function readFirestoreBoolean(
  fields: Record<string, FirestoreFieldValue> | undefined,
  key: string
): boolean {
  return fields?.[key]?.booleanValue === true;
}

/**
 * Authenticated admin removal of a gift order record.
 * - Confirmed financial records / webhook payments are soft-archived (never permanently deleted).
 * - Unconfirmed/test/cancelled orders are permanently deleted after confirmation.
 * - Never alters gift quota availability automatically.
 */
app.delete('/api/admin/gift-orders/:orderId', rateLimit(30, 60_000), async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) {
      res.status(400).json({ error: 'Identificador de registro inválido.' });
      return;
    }

    const authUser = await verifyAuthenticatedAdminRequest(req.header('authorization') || '');
    const { projectId, firestoreDatabaseId } = authUser.config;
    const baseDocumentsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${firestoreDatabaseId}/documents`;
    const orderDocName = `projects/${projectId}/databases/${firestoreDatabaseId}/documents/gift_orders/${orderId}`;

    const getOrderRes = await fetch(`${baseDocumentsUrl}/gift_orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${authUser.idToken}` },
      signal: AbortSignal.timeout(8000),
    });

    if (getOrderRes.status === 404) {
      res.status(404).json({ error: 'Registro não encontrado.' });
      return;
    }
    if (getOrderRes.status === 401 || getOrderRes.status === 403) {
      res.status(403).json({ error: 'Sem permissão administrativa para acessar este registro.' });
      return;
    }
    if (!getOrderRes.ok) {
      res.status(502).json({ error: 'Não foi possível consultar o registro no banco de dados.' });
      return;
    }

    const orderDoc = (await getOrderRes.json()) as {
      fields?: Record<string, FirestoreFieldValue>;
    };
    const fields = orderDoc.fields;
    const status = readFirestoreString(fields, 'status');
    const confirmedAtIso = readFirestoreString(fields, 'confirmedAtIso');
    const paymentMethod = readFirestoreString(fields, 'paymentMethod');
    const giftTitle = readFirestoreString(fields, 'giftTitle') || orderId;
    const alreadyArchived = readFirestoreBoolean(fields, 'adminArchived');

    const isConfirmedFinancial =
      status === 'confirmed' || Boolean(confirmedAtIso) || paymentMethod === 'pix_webhook';

    if (isConfirmedFinancial && alreadyArchived) {
      res.json({
        ok: true,
        mode: 'archived',
        orderId,
      });
      return;
    }

    const logId = `log_${crypto.randomBytes(6).toString('hex')}`;
    const logDocName = `projects/${projectId}/databases/${firestoreDatabaseId}/documents/admin_logs/${logId}`;

    const primaryWrite = isConfirmedFinancial
      ? {
          update: {
            name: orderDocName,
            fields: {
              adminArchived: { booleanValue: true },
              adminArchivedAtIso: { stringValue: new Date().toISOString().slice(0, 40) },
              adminArchivedBy: { stringValue: authUser.email.slice(0, 200) },
            },
          },
          updateMask: {
            fieldPaths: ['adminArchived', 'adminArchivedAtIso', 'adminArchivedBy'],
          },
          updateTransforms: [
            {
              fieldPath: 'updatedAt',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
          currentDocument: { exists: true },
        }
      : {
          delete: orderDocName,
          currentDocument: { exists: true },
        };

    const logWrite = {
      update: {
        name: logDocName,
        fields: {
          actorUid: { stringValue: authUser.uid },
          actorEmail: { stringValue: authUser.email.slice(0, 200) },
          action: {
            stringValue: isConfirmedFinancial
              ? 'Registro financeiro arquivado'
              : 'Registro de reserva excluído',
          },
          details: {
            stringValue: `${giftTitle} (${orderId}) — status: ${status || 'desconhecido'}`.slice(
              0,
              500
            ),
          },
        },
      },
      updateTransforms: [
        {
          fieldPath: 'createdAt',
          setToServerValue: 'REQUEST_TIME',
        },
      ],
      currentDocument: { exists: false },
    };

    const commitRes = await fetch(`${baseDocumentsUrl}:commit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authUser.idToken}`,
      },
      body: JSON.stringify({
        writes: [primaryWrite, logWrite],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!commitRes.ok) {
      const errText = await commitRes.text().catch(() => '');
      console.error('Erro ao persistir exclusão/arquivamento de gift_order:', commitRes.status, errText);
      res.status(commitRes.status === 403 ? 403 : 500).json({
        error:
          commitRes.status === 403
            ? 'Operação bloqueada pelas regras de segurança.'
            : 'Não foi possível concluir a remoção no banco de dados.',
      });
      return;
    }

    res.json({
      ok: true,
      mode: isConfirmedFinancial ? 'archived' : 'deleted',
      orderId,
    });
  } catch (err) {
    if (err instanceof HttpStatusError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('Erro no endpoint de exclusão de pedido:', err);
    res.status(500).json({ error: 'Erro interno ao processar a exclusão do registro.' });
  }
});

/**
 * Authenticated Pix provider webhook endpoint.
 * Secrets stay strictly on the server (never exposed in browser code).
 */
app.post('/api/webhooks/pix', rateLimit(60, 60_000), async (req: express.Request & { rawBody?: Buffer }, res) => {
  const webhookSecret = process.env.PIX_WEBHOOK_SECRET;
  if (!webhookSecret) {
    res.status(501).json({
      configured: false,
      message: 'PIX_WEBHOOK_SECRET não configurado no servidor. Modo conferência manual ativo.',
    });
    return;
  }

  const signature = req.header('x-pix-signature') || '';
  const authHeader = req.header('authorization') || '';

  const expectedHmac = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
    .digest('hex');

  const signatureValid =
    (signature &&
      signature.length === expectedHmac.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac))) ||
    authHeader === `Bearer ${webhookSecret}`;

  if (!signatureValid) {
    res.status(401).json({ error: 'Assinatura de webhook inválida.' });
    return;
  }

  const { orderId, status } = req.body as { orderId?: string; status?: string };
  if (!orderId || status !== 'paid') {
    res.status(400).json({ error: 'Payload de webhook inválido ou status não confirmado.' });
    return;
  }

  // Note: To update Firestore server-side on webhook, configure FIREBASE_SERVICE_ACCOUNT_JSON
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    res.status(202).json({
      verified: true,
      persisted: false,
      message:
        'Webhook autenticado com sucesso, mas FIREBASE_SERVICE_ACCOUNT_JSON não está definido para gravar no Firestore.',
    });
    return;
  }

  res.status(200).json({
    verified: true,
    orderId,
    status: 'confirmed',
  });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nosso Para Sempre rodando na porta ${PORT}`);
  });
}

startServer();
