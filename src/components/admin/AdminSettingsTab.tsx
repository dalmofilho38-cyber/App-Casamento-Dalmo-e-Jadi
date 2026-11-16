import React, { useEffect, useState } from 'react';
import { CheckCircle2, Save, Shield, UserPlus } from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useWedding } from '../../context/WeddingContext';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { generateRandomToken } from '../../lib/pix';
import { sanitizeSiteSettingsForFirestore } from '../../lib/settingsSanitizer';
import { PixKeyType, PixProviderMode, SiteSettings } from '../../types/wedding';

export const AdminSettingsTab: React.FC = () => {
  const { settings, user, demoAdminActive, isAdmin, firestoreConnected, demoActions } = useWedding();
  const [form, setForm] = useState<SiteSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  const [coAdminUid, setCoAdminUid] = useState('');
  const [coAdminEmail, setCoAdminEmail] = useState('');
  const [coAdminMsg, setCoAdminMsg] = useState<string | null>(null);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedOk(false);
    try {
      const sanitized = sanitizeSiteSettingsForFirestore({
        ...settings,
        ...form,
      });

      if (demoAdminActive || !isAdmin || !firestoreConnected) {
        demoActions.updateSettings({
          ...settings,
          ...form,
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
          action: 'Configurações atualizadas',
          details: 'Dados gerais, Pix, prazos ou localização salvos no Firestore.',
          createdAt: serverTimestamp(),
        });
      }
      setSavedOk(true);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'site_settings/main');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCoAdminMsg(null);
    if (!coAdminUid.trim() || !coAdminEmail.trim()) return;
    try {
      await setDoc(doc(db, 'admins', coAdminUid.trim()), {
        uid: coAdminUid.trim(),
        email: coAdminEmail.trim(),
        role: 'couple',
        createdAt: serverTimestamp(),
      });
      setCoAdminMsg('Administrador adicionado com sucesso.');
      setCoAdminUid('');
      setCoAdminEmail('');
    } catch (err) {
      setCoAdminMsg('Verifique se o UID contém apenas letras, números, _ ou -.');
      try {
        handleFirestoreError(err, OperationType.CREATE, 'admins');
      } catch {
        // logged
      }
    }
  };

  return (
    <div className="space-y-8">
      <form
        onSubmit={handleSave}
        className="space-y-6 rounded-lg border border-dourado/35 bg-creme-claro p-6 sm:p-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-dourado/25 pb-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-marrom">
              Configurações Gerais, Pix &amp; Cerimônia
            </h2>
            <p className="text-xs text-marrom-suave">
              Personalize textos, prazo do RSVP, endereço exato e dados reais do Pix.
            </p>
          </div>
          {savedOk && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-salvia">
              <CheckCircle2 className="h-4 w-4" />
              Salvo no Firestore!
            </span>
          )}
        </div>

        {/* Pix Config */}
        <div className="space-y-4 rounded-md border border-dourado/30 bg-creme/55 p-5">
          <h3 className="font-display text-xl font-semibold text-marrom">Configuração do Pix</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-marrom">Modo de operação</label>
              <select
                value={form.pixProviderMode}
                onChange={(e) =>
                  setForm({ ...form, pixProviderMode: e.target.value as PixProviderMode })
                }
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              >
                <option value="demo_unconfigured">Modo demonstração (sem chave)</option>
                <option value="manual_pix">Pix Copia e Cola / QR estático (conferência manual)</option>
                <option value="webhook_provider">Provedor Pix com webhook no servidor</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom">Tipo de chave Pix</label>
              <select
                value={form.pixKeyType}
                onChange={(e) => setForm({ ...form, pixKeyType: e.target.value as PixKeyType })}
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              >
                <option value="unconfigured">Não configurada</option>
                <option value="evp">Chave aleatória (EVP)</option>
                <option value="email">E-mail</option>
                <option value="phone">Celular (+55...)</option>
                <option value="cpf">CPF</option>
                <option value="cnpj">CNPJ</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom">Chave Pix real</label>
              <input
                type="text"
                maxLength={140}
                value={form.pixKey}
                onChange={(e) => setForm({ ...form, pixKey: e.target.value })}
                placeholder="Cole aqui a chave Pix oficial do casal"
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom">Nome do favorecido</label>
              <input
                type="text"
                maxLength={80}
                value={form.pixBeneficiaryName}
                onChange={(e) => setForm({ ...form, pixBeneficiaryName: e.target.value })}
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom">Cidade do recebedor Pix</label>
              <input
                type="text"
                maxLength={40}
                value={form.pixCity}
                onChange={(e) => setForm({ ...form, pixCity: e.target.value })}
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-marrom">
                Expiração da reserva (minutos)
              </label>
              <input
                type="number"
                min={5}
                max={10080}
                value={form.giftReservationExpiryMinutes}
                onChange={(e) =>
                  setForm({ ...form, giftReservationExpiryMinutes: Number(e.target.value) })
                }
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm tabular-nums"
              />
            </div>
          </div>

          <p className="text-xs text-marrom-suave">
            Para confirmação automática via webhook, configure as variáveis de ambiente seguras no
            servidor: <code>PIX_WEBHOOK_SECRET</code> e <code>FIREBASE_SERVICE_ACCOUNT_JSON</code>{' '}
            apontando o endpoint <code>POST /api/webhooks/pix</code>.
          </p>
        </div>

        {/* Venue & RSVP Settings */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-marrom">
              Endereço completo da rua (opcional)
            </label>
            <input
              type="text"
              maxLength={240}
              value={form.venueStreetAddress}
              onChange={(e) => setForm({ ...form, venueStreetAddress: e.target.value })}
              placeholder="Rua, número e bairro"
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">
              Coordenadas (latitude, longitude)
            </label>
            <input
              type="text"
              maxLength={80}
              value={form.venueCoordinates}
              onChange={(e) => setForm({ ...form, venueCoordinates: e.target.value })}
              placeholder="Ex.: -15.6108, -42.5403"
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">Link direto Google Maps</label>
            <input
              type="url"
              maxLength={500}
              value={form.venueMapUrl}
              onChange={(e) => setForm({ ...form, venueMapUrl: e.target.value })}
              placeholder="https://maps.google.com/..."
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">
              URL da foto real da fachada da igreja
            </label>
            <input
              type="text"
              maxLength={600}
              value={form.venuePhotoUrl || ''}
              onChange={(e) => setForm({ ...form, venuePhotoUrl: e.target.value })}
              placeholder="/church-facade.png ou https://..."
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">Data-limite do RSVP</label>
            <input
              type="date"
              value={form.rsvpDeadlineIso ? form.rsvpDeadlineIso.slice(0, 10) : ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  rsvpDeadlineIso: e.target.value ? `${e.target.value}T23:59:59-03:00` : '',
                })
              }
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">
              Máximo de participantes por envio RSVP
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={form.rsvpMaxGuestsPerSubmission}
              onChange={(e) =>
                setForm({ ...form, rsvpMaxGuestsPerSubmission: Number(e.target.value) })
              }
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">E-mail de contato LGPD</label>
            <input
              type="email"
              maxLength={160}
              value={form.lgpdContactEmail}
              onChange={(e) => setForm({ ...form, lgpdContactEmail: e.target.value })}
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">Título da meta</label>
            <input
              type="text"
              maxLength={140}
              value={form.goalTitle}
              onChange={(e) => setForm({ ...form, goalTitle: e.target.value })}
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">Meta financeira (R$)</label>
            <input
              type="number"
              min={0}
              value={Math.round(form.goalAmountCents / 100)}
              onChange={(e) =>
                setForm({ ...form, goalAmountCents: Math.max(0, Number(e.target.value)) * 100 })
              }
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm tabular-nums"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-marrom">Frase principal (Hero)</label>
            <textarea
              rows={2}
              maxLength={400}
              value={form.heroQuote}
              onChange={(e) => setForm({ ...form, heroQuote: e.target.value })}
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-marrom">
              Texto de introdução da Lista de Presentes
            </label>
            <textarea
              rows={2}
              maxLength={500}
              value={form.giftIntroMessage}
              onChange={(e) => setForm({ ...form, giftIntroMessage: e.target.value })}
              className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-terracota-escuro px-6 py-3 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Salvando...' : 'Salvar configurações'}
        </button>
      </form>

      {/* Co-admin Management */}
      <section className="rounded-lg border border-dourado/35 bg-creme-claro p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-salvia" />
          <h3 className="font-display text-2xl font-semibold text-marrom">
            Administradores Autorizados
          </h3>
        </div>
        <p className="text-xs text-marrom-suave">
          Seu UID atual: <code className="bg-creme px-1.5 py-0.5 rounded">{user?.uid}</code> · Para
          liberar o acesso de Jadi ou outro administrador, informe o UID e e-mail Google abaixo.
        </p>

        <form onSubmit={handleAddAdmin} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <input
            type="text"
            required
            value={coAdminUid}
            onChange={(e) => setCoAdminUid(e.target.value)}
            placeholder="UID do usuário no Firebase Auth"
            className="rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
          />
          <input
            type="email"
            required
            value={coAdminEmail}
            onChange={(e) => setCoAdminEmail(e.target.value)}
            placeholder="E-mail Google do administrador"
            className="rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-terracota-escuro px-4 py-2 text-xs font-semibold text-terracota-escuro uppercase hover:bg-terracota/10"
          >
            <UserPlus className="h-4 w-4" />
            Adicionar admin
          </button>
        </form>
        {coAdminMsg && <p className="text-xs text-salvia font-medium">{coAdminMsg}</p>}
      </section>
    </div>
  );
};
