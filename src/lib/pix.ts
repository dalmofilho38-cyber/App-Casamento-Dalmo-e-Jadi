export function formatBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function generateRandomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeAscii(str: string, maxLen: number): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 \-.]/g, '')
    .trim()
    .slice(0, maxLen);
}

function tlv(id: string, value: string): string {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PixPayloadInput {
  pixKey: string;
  beneficiaryName: string;
  city: string;
  amountCents?: number;
  txid?: string;
  description?: string;
}

/**
 * Generates an official EMVCo / Banco Central do Brasil Pix BR Code ("Pix Copia e Cola").
 * Returns null if pixKey is empty or unconfigured so fake Pix codes are never generated.
 */
export function buildPixBrCode(input: PixPayloadInput): string | null {
  const key = input.pixKey.trim();
  if (!key) return null;

  const merchantAccountSub =
    tlv('00', 'br.gov.bcb.pix') +
    tlv('01', key.slice(0, 77)) +
    (input.description ? tlv('02', normalizeAscii(input.description, 40)) : '');

  const name = normalizeAscii(input.beneficiaryName || 'DALMO E JADI', 25) || 'NOIVOS';
  const city = normalizeAscii(input.city || 'RIO PARDO DE MINAS', 15) || 'BRASIL';
  const txid = normalizeAscii(input.txid || 'CASAMENTO', 25).replace(/\s+/g, '') || 'CASAMENTO';

  let payload = '';
  payload += tlv('00', '01');
  payload += tlv('26', merchantAccountSub);
  payload += tlv('52', '0000');
  payload += tlv('53', '986');
  if (input.amountCents && input.amountCents >= 100) {
    payload += tlv('54', (input.amountCents / 100).toFixed(2));
  }
  payload += tlv('58', 'BR');
  payload += tlv('59', name);
  payload += tlv('60', city);
  payload += tlv('62', tlv('05', txid));
  payload += '6304';

  const checksum = crc16Ccitt(payload);
  return `${payload}${checksum}`;
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | boolean)[][]): void {
  const escape = (val: string | number | boolean) => {
    const str = String(val ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  };
  const csvContent =
    '\uFEFF' +
    [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
