import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CheckCircle2,
  Eye,
  EyeOff,
  Heart,
  Loader2,
  MapPin,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useWedding } from '../../context/WeddingContext';
import { DEFAULT_PADRINHOS_SLOTS, DEFAULT_SITE_SETTINGS } from '../../data/defaults';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { generateRandomToken } from '../../lib/pix';
import {
  normalizeVenueCityDisplay,
  resolveCeremonyPastor,
  resolvePadrinhosList,
  sanitizeSiteSettingsForFirestore,
} from '../../lib/settingsSanitizer';
import { PadrinhoEntry, PadrinhoSide, SiteSettings } from '../../types/wedding';

function createClientId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function uploadCeremonyImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Selecione uma imagem JPG, PNG ou WEBP.');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('A imagem deve ter no máximo 12 MB.');
  }

  const res = await fetch('/api/media/ceremony', {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
    },
    body: file,
  });

  const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !payload.url) {
    throw new Error(payload.error || 'Não foi possível enviar a imagem.');
  }
  return payload.url;
}

export const AdminCeremonyTab: React.FC = () => {
  const { settings, user, isAdmin, demoAdminActive, firestoreConnected, demoActions } =
    useWedding();

  const [form, setForm] = useState<SiteSettings>(() => ({
    ...DEFAULT_SITE_SETTINGS,
    ...settings,
    ceremonyPastor: resolveCeremonyPastor(settings.ceremonyPastor),
    padrinhos: resolvePadrinhosList(settings.padrinhos),
  }));

  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadingChurch, setUploadingChurch] = useState(false);

  useEffect(() => {
    setForm({
      ...DEFAULT_SITE_SETTINGS,
      ...settings,
      venueCity: normalizeVenueCityDisplay(settings.venueCity),
      ceremonyPastor: resolveCeremonyPastor(settings.ceremonyPastor),
      padrinhos: resolvePadrinhosList(settings.padrinhos),
    });
  }, [settings]);

  const padrinhos = form.padrinhos ?? [];
  const churchPreviewUrl = form.venuePhotoUrl?.trim() || '/images/igreja-jardim-florestal.png';

  const handleUploadChurchPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrorMsg(null);
    setUploadingChurch(true);
    try {
      const url = await uploadCeremonyImage(file);
      setForm((prev) => ({ ...prev, venuePhotoUrl: url }));
      setSavedOk(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao enviar foto da igreja.');
    } finally {
      setUploadingChurch(false);
    }
  };

  const normalizeSideOrder = (list: PadrinhoEntry[]): PadrinhoEntry[] => {
    const noiva = list
      .filter((p) => p.side === 'noiva')
      .sort((a, b) => a.order - b.order)
      .map((p, idx) => ({ ...p, order: idx + 1 }));
    const noivo = list
      .filter((p) => p.side === 'noivo')
      .sort((a, b) => a.order - b.order)
      .map((p, idx) => ({ ...p, order: idx + 1 }));
    return [...noiva, ...noivo];
  };

  const handleAddPadrinho = (side: PadrinhoSide) => {
    if (padrinhos.length >= 30) return;
    const sameSideCount = padrinhos.filter((p) => p.side === side).length;
    const entry: PadrinhoEntry = {
      id: createClientId(`padrinho-${side}`),
      side,
      name: '',
      published: true,
      order: sameSideCount + 1,
    };
    setForm((prev) => ({
      ...prev,
      padrinhos: normalizeSideOrder([...(prev.padrinhos ?? []), entry]),
    }));
    setSavedOk(false);
  };

  const handleUpdatePadrinho = (id: string, patch: Partial<PadrinhoEntry>) => {
    setForm((prev) => {
      const updated = (prev.padrinhos ?? []).map((p) =>
        p.id === id ? { ...p, ...patch } : p
      );
      return {
        ...prev,
        padrinhos: patch.side ? normalizeSideOrder(updated) : updated,
      };
    });
    setSavedOk(false);
  };

  const handleMovePadrinho = (side: PadrinhoSide, id: string, direction: -1 | 1) => {
    const sideItems = padrinhos
      .filter((p) => p.side === side)
      .sort((a, b) => a.order - b.order);
    const idx = sideItems.findIndex((p) => p.id === id);
    const targetIdx = idx + direction;
    if (idx < 0 || targetIdx < 0 || targetIdx >= sideItems.length) return;
    const reordered = [...sideItems];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(targetIdx, 0, moved);
    const otherSide = padrinhos.filter((p) => p.side !== side);
    setForm((prev) => ({
      ...prev,
      padrinhos: normalizeSideOrder([
        ...otherSide,
        ...reordered.map((item, i) => ({ ...item, order: i + 1 })),
      ]),
    }));
    setSavedOk(false);
  };

  const handleDeletePadrinho = (id: string) => {
    setForm((prev) => ({
      ...prev,
      padrinhos: normalizeSideOrder((prev.padrinhos ?? []).filter((p) => p.id !== id)),
    }));
    setSavedOk(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedOk(false);
    setErrorMsg(null);

    try {
      const merged: SiteSettings = {
        ...settings,
        ...form,
        padrinhos: normalizeSideOrder(form.padrinhos ?? []),
      };
      const sanitized = sanitizeSiteSettingsForFirestore(merged);

      if (demoAdminActive || !isAdmin || !firestoreConnected) {
        demoActions.updateSettings({
          ...merged,
          ...(sanitized as Partial<SiteSettings>),
        });
        setSavedOk(true);
        return;
      }

      await setDoc(doc(db, 'site_settings', 'main'), {
        ...sanitized,
        updatedAt: serverTimestamp(),
      });

      if (user) {
        await setDoc(doc(db, 'admin_logs', `log_${generateRandomToken(6)}`), {
          actorUid: user.uid,
          actorEmail: user.email || '',
          action: 'Cerimônia atualizada',
          details: 'Dados da cerimônia, localização e lista de padrinhos e madrinhas salvos.',
          createdAt: serverTimestamp(),
        });
      }
      setSavedOk(true);
    } catch (err) {
      setErrorMsg('Não foi possível salvar no Firestore. Verifique sua conexão e permissões.');
      try {
        handleFirestoreError(err, OperationType.WRITE, 'site_settings/main');
      } catch {
        // handled cleanly in UI state
      }
    } finally {
      setSaving(false);
    }
  };

  const renderGroupColumn = (side: PadrinhoSide, title: string, addLabel: string) => {
    const items = padrinhos
      .filter((p) => p.side === side)
      .sort((a, b) => a.order - b.order);

    return (
      <div className="rounded-lg border border-dourado/35 bg-marfim/75 p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dourado/25 pb-3">
          <div>
            <h4 className="font-display text-xl font-semibold text-terracota-escuro">{title}</h4>
            <p className="text-xs text-marrom-suave">
              {items.filter((i) => i.published && i.name.trim()).length} publicado(s) ·{' '}
              {items.length} registro(s)
            </p>
          </div>
          <button
            type="button"
            disabled={padrinhos.length >= 30}
            onClick={() => handleAddPadrinho(side)}
            className="inline-flex items-center gap-1.5 rounded-md border border-terracota-escuro px-3 py-1.5 text-xs font-semibold text-terracota-escuro hover:bg-terracota/10 disabled:opacity-40 whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
          </button>
        </div>

        {items.length === 0 ? (
          <p className="text-xs text-marrom-suave italic py-4 text-center">
            Nenhum nome cadastrado neste grupo.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, idx) => (
              <li
                key={item.id}
                className="rounded-md border border-dourado/30 bg-creme-claro p-3 space-y-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-dourado tabular-nums w-5 shrink-0">
                    {idx + 1}.
                  </span>
                  <input
                    type="text"
                    maxLength={120}
                    value={item.name}
                    onChange={(e) => handleUpdatePadrinho(item.id, { name: e.target.value })}
                    placeholder={side === 'noiva' ? 'Nome da madrinha' : 'Nome do padrinho'}
                    className="w-full rounded-md border border-dourado/40 bg-marfim px-3 py-1.5 text-sm text-marrom"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pl-7">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdatePadrinho(item.id, { published: !item.published })
                      }
                      className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        item.published
                          ? 'bg-salvia/15 text-salvia border border-salvia/35'
                          : 'bg-pergaminho text-marrom-suave border border-dourado/35'
                      }`}
                    >
                      {item.published ? (
                        <>
                          <Eye className="h-3 w-3" />
                          Publicado
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-3 w-3" />
                          Oculto
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleUpdatePadrinho(item.id, {
                          side: side === 'noiva' ? 'noivo' : 'noiva',
                        })
                      }
                      className="inline-flex items-center gap-1 rounded border border-dourado/35 px-2 py-1 text-[11px] text-marrom-suave hover:bg-pergaminho"
                    >
                      <ArrowLeftRight className="h-3 w-3" />
                      {side === 'noiva' ? 'Mover para Padrinhos' : 'Mover para Madrinhas'}
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMovePadrinho(side, item.id, -1)}
                      aria-label="Mover para cima"
                      className="rounded border border-dourado/35 p-1 text-marrom-suave hover:bg-pergaminho disabled:opacity-35"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === items.length - 1}
                      onClick={() => handleMovePadrinho(side, item.id, 1)}
                      aria-label="Mover para baixo"
                      className="rounded border border-dourado/35 p-1 text-marrom-suave hover:bg-pergaminho disabled:opacity-35"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeletePadrinho(item.id)}
                      aria-label="Remover pessoa"
                      className="rounded border border-terracota/35 p-1 text-terracota-escuro hover:bg-terracota/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleSave} className="space-y-8">
      {/* Top Save Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dourado/40 bg-creme-claro p-5 sm:p-6">
        <div>
          <h2 className="font-display text-2xl font-semibold text-marrom">
            Página da Cerimônia
          </h2>
          <p className="text-xs text-marrom-suave">
            Edite informações da igreja, fotografia, mapa, Pastor, Cerimonialista e a lista de
            Madrinhas e Padrinhos.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {savedOk && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-salvia">
              <CheckCircle2 className="h-4 w-4" />
              Alterações salvas!
            </span>
          )}
          <button
            type="submit"
            disabled={saving || uploadingChurch}
            className="inline-flex items-center gap-2 rounded-md bg-terracota-escuro px-5 py-2.5 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Salvando...' : 'Salvar Cerimônia'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-md border border-terracota/40 bg-terracota/10 p-3.5 text-xs text-terracota-escuro">
          {errorMsg}
        </div>
      )}

      {/* 1. Church Photo & Core Ceremony Info */}
      <section className="rounded-lg border border-dourado/35 bg-creme-claro p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-2 border-b border-dourado/25 pb-3">
          <MapPin className="h-5 w-5 text-terracota-escuro" />
          <h3 className="font-display text-2xl font-semibold text-marrom">
            Cerimônia, Igreja &amp; Localização
          </h3>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          {/* Church Photo */}
          <div className="lg:col-span-5 space-y-3">
            <label className="block text-xs font-semibold tracking-wider text-marrom uppercase">
              Fotografia Real da Igreja
            </label>
            <div className="overflow-hidden rounded-lg border border-dourado/45 bg-marfim p-2">
              <img
                src={churchPreviewUrl}
                alt="Pré-visualização da fachada da igreja"
                className="h-52 w-full rounded object-cover object-center"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-terracota-escuro px-3.5 py-2 text-xs font-semibold text-creme-claro hover:bg-terracota">
                {uploadingChurch ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {uploadingChurch ? 'Enviando...' : 'Enviar nova foto'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleUploadChurchPhoto}
                  className="hidden"
                />
              </label>
              {form.venuePhotoUrl?.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    setForm((prev) => ({ ...prev, venuePhotoUrl: '' }));
                    setSavedOk(false);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-dourado/50 px-3 py-2 text-xs font-medium text-marrom hover:bg-pergaminho"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Usar foto original
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom-suave">
                Ou informe o endereço/URL da foto
              </label>
              <input
                type="text"
                maxLength={600}
                value={form.venuePhotoUrl || ''}
                onChange={(e) => setForm({ ...form, venuePhotoUrl: e.target.value })}
                placeholder="/images/igreja-jardim-florestal.png"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-xs"
              />
            </div>
          </div>

          {/* Fields */}
          <div className="lg:col-span-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-marrom">Data</label>
              <input
                type="text"
                maxLength={100}
                value={form.weddingDateDisplay}
                onChange={(e) => setForm({ ...form, weddingDateDisplay: e.target.value })}
                placeholder="Domingo, 10 de janeiro de 2027"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">Horário</label>
              <input
                type="text"
                maxLength={40}
                value={form.weddingTimeDisplay}
                onChange={(e) => setForm({ ...form, weddingTimeDisplay: e.target.value })}
                placeholder="15h"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-marrom">Nome da igreja</label>
              <input
                type="text"
                required
                maxLength={200}
                value={form.venueName}
                onChange={(e) => setForm({ ...form, venueName: e.target.value })}
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">Cidade</label>
              <input
                type="text"
                required
                maxLength={120}
                value={form.venueCity}
                onChange={(e) => setForm({ ...form, venueCity: e.target.value })}
                placeholder="Rio Pardo de Minas — MG"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">CEP</label>
              <input
                type="text"
                maxLength={20}
                value={form.venueCep || ''}
                onChange={(e) => setForm({ ...form, venueCep: e.target.value })}
                placeholder="39530-000"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-marrom">
                Endereço / Bairro (para detalhes e mapa)
              </label>
              <input
                type="text"
                maxLength={240}
                value={form.venueStreetAddress}
                onChange={(e) => setForm({ ...form, venueStreetAddress: e.target.value })}
                placeholder="Jardim Florestal, Rio Pardo de Minas – MG"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">Pastor</label>
              <input
                type="text"
                maxLength={120}
                value={form.ceremonyPastor || ''}
                onChange={(e) => setForm({ ...form, ceremonyPastor: e.target.value })}
                placeholder="Pr. Fabiano Paulo de Andrade"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">Cerimonialista</label>
              <input
                type="text"
                maxLength={120}
                value={form.ceremonyPlanner || ''}
                onChange={(e) => setForm({ ...form, ceremonyPlanner: e.target.value })}
                placeholder="Ludimila De Giovanni"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">
                Coordenadas do mapa (lat, lng)
              </label>
              <input
                type="text"
                maxLength={80}
                value={form.venueCoordinates}
                onChange={(e) => setForm({ ...form, venueCoordinates: e.target.value })}
                placeholder="Ex.: -15.6108, -42.5403"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">
                Link personalizado do Google Maps
              </label>
              <input
                type="url"
                maxLength={500}
                value={form.venueMapUrl}
                onChange={(e) => setForm({ ...form, venueMapUrl: e.target.value })}
                placeholder="https://maps.google.com/..."
                className="mt-1 w-full rounded-md border border-dourado/40 bg-marfim px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>
      </section>

      {/* 2. Padrinhos e Madrinhas Manager */}
      <section className="rounded-lg border border-dourado/35 bg-creme-claro p-6 sm:p-8 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dourado/25 pb-3">
          <div className="flex items-center gap-2">
            <Heart className="h-5 w-5 text-terracota-escuro" />
            <div>
              <h3 className="font-display text-2xl font-semibold text-marrom">
                Nossas Madrinhas e Padrinhos
              </h3>
              <p className="text-xs text-marrom-suave">
                Edite nomes, reordene, adicione ou remova pessoas, defina o grupo (Madrinhas ou
                Padrinhos) e salve as alterações.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setForm((prev) => ({ ...prev, padrinhos: DEFAULT_PADRINHOS_SLOTS }));
              setSavedOk(false);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-dourado/45 px-3 py-1.5 text-xs font-medium text-marrom hover:bg-pergaminho"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar lista inicial (6 + 6)
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {renderGroupColumn('noiva', 'Madrinhas', 'Adicionar Madrinha')}
          {renderGroupColumn('noivo', 'Padrinhos', 'Adicionar Padrinho')}
        </div>
      </section>

      {/* Bottom Save Button */}
      <div className="flex items-center justify-end gap-4">
        {savedOk && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-salvia">
            <CheckCircle2 className="h-4 w-4" />
            Alterações da Cerimônia salvas!
          </span>
        )}
        <button
          type="submit"
          disabled={saving || uploadingChurch}
          className="inline-flex items-center gap-2 rounded-md bg-terracota-escuro px-6 py-3 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Salvando...' : 'Salvar configurações da Cerimônia'}
        </button>
      </div>
    </form>
  );
};
