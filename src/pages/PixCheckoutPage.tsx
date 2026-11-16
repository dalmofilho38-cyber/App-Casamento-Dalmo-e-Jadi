import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  FileUp,
  HeartHandshake,
  Lock,
  QrCode,
} from 'lucide-react';
import { doc, increment, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { useWedding } from '../context/WeddingContext';
import { db, handleFirestoreError, OperationType, storage } from '../lib/firebase';
import { buildPixBrCode, formatBRL, generateRandomToken, sha256Hex } from '../lib/pix';

interface CreatedOrderSession {
  orderId: string;
  orderToken: string;
  orderTokenHash: string;
  amountCents: number;
  giftTitle: string;
  status: 'reserved' | 'awaiting_confirmation';
  expiresAtIso: string;
  pixPayload: string | null;
  savedMode: 'firestore' | 'demo';
}

export const PixCheckoutPage: React.FC = () => {
  const {
    settings,
    cart,
    clearCart,
    setPrivacyModalOpen,
    isDemoMode,
    demoAdminActive,
    demoActions,
  } = useWedding();
  const [searchParams] = useSearchParams();
  const isCustomDefault = searchParams.get('custom') === '1' || cart.length === 0;

  const [useCustomAmount, setUseCustomAmount] = useState(isCustomDefault);
  const [customAmountReais, setCustomAmountReais] = useState('150,00');
  const [giverName, setGiverName] = useState('');
  const [giverContact, setGiverContact] = useState('');
  const [messageToCouple, setMessageToCouple] = useState('');
  const [lgpdConsent, setLgpdConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orderSession, setOrderSession] = useState<CreatedOrderSession | null>(null);

  const [copied, setCopied] = useState(false);
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [receiptSent, setReceiptSent] = useState(false);

  const parsedCustomCents = useMemo(() => {
    const cleaned = customAmountReais.replace(/[^\d,]/g, '').replace(',', '.');
    const num = Number.parseFloat(cleaned);
    if (Number.isNaN(num) || num < 1) return 0;
    return Math.round(num * 100);
  }, [customAmountReais]);

  const getCartItemTotalCents = (item: (typeof cart)[number]) => {
    const isFlexible = item.gift.category === 'Lua de mel' || item.gift.giftType === 'symbolic';
    return isFlexible ? (item.customAmountCents ?? item.gift.priceCents) : item.gift.priceCents * item.quotas;
  };

  const cartTotalCents = useMemo(
    () =>
      cart.reduce((acc, item) => {
        const isFlexible = item.gift.category === 'Lua de mel' || item.gift.giftType === 'symbolic';
        return (
          acc +
          (isFlexible ? (item.customAmountCents ?? item.gift.priceCents) : item.gift.priceCents * item.quotas)
        );
      }, 0),
    [cart]
  );

  const finalAmountCents = useCustomAmount ? parsedCustomCents : cartTotalCents;
  const pixConfigured = Boolean(settings.pixKey && settings.pixKey.trim().length >= 5);

  const handleReserveAndGeneratePix = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (finalAmountCents < 100) {
      setErrorMsg('Informe um valor mínimo de R$ 1,00 para continuar.');
      return;
    }
    if (giverName.trim().length < 2) {
      setErrorMsg('Informe seu nome completo.');
      return;
    }
    if (giverContact.trim().length < 3) {
      setErrorMsg('Informe um telefone ou e-mail para contato.');
      return;
    }
    if (!lgpdConsent) {
      setErrorMsg('É necessário concordar com a política de privacidade (LGPD).');
      return;
    }

    setSubmitting(true);
    try {
      const expiryMinutes = settings.giftReservationExpiryMinutes || 60;
      const expiresAtIso = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

      const orderToken = generateRandomToken(16);
      const orderTokenHash = await sha256Hex(orderToken);

      const primaryGift = !useCustomAmount && cart.length > 0 ? cart[0].gift : undefined;
      const giftTitle = useCustomAmount
        ? 'Contribuição livre para Dalmo & Jadi'
        : cart
            .map((c) => {
              const isFlexible = c.gift.category === 'Lua de mel' || c.gift.giftType === 'symbolic';
              return isFlexible
                ? `${c.gift.title} (${formatBRL(getCartItemTotalCents(c))})`
                : `${c.gift.title} (${c.quotas}x)`;
            })
            .join(', ')
            .slice(0, 155);

      const orderId = `ord_${generateRandomToken(8)}`;
      let savedMode: 'firestore' | 'demo' = 'demo';

      if (!isDemoMode && !demoAdminActive) {
        try {
          const batch = writeBatch(db);
          const now = serverTimestamp();
          const orderRef = doc(db, 'gift_orders', orderId);

          if (!useCustomAmount) {
            for (const item of cart) {
              if (!item.gift.id.startsWith('demo-')) {
                const giftRef = doc(db, 'gifts', item.gift.id);
                batch.update(giftRef, {
                  reservedQuotas: increment(item.quotas),
                  updatedAt: now,
                });
              }
            }
          }

          batch.set(orderRef, {
            ...(primaryGift ? { giftId: primaryGift.id } : {}),
            giftTitle,
            isCustomAmount: useCustomAmount,
            quotas: useCustomAmount ? 1 : cart.reduce((a, b) => a + b.quotas, 0),
            amountCents: finalAmountCents,
            giverName: giverName.trim().slice(0, 120),
            giverContact: giverContact.trim().slice(0, 140),
            ...(messageToCouple.trim()
              ? { messageToCouple: messageToCouple.trim().slice(0, 800) }
              : {}),
            status: 'reserved',
            paymentMethod: pixConfigured ? 'pix_manual' : 'demo_preview',
            orderTokenHash,
            lgpdConsent: true,
            expiresAtIso,
            createdAt: now,
            updatedAt: now,
          });

          await batch.commit();
          savedMode = 'firestore';
        } catch (err) {
          console.warn('Fallback para reserva em modo demonstração:', err);
          savedMode = 'demo';
        }
      }

      if (savedMode === 'demo') {
        demoActions.createGiftOrder(
          {
            id: orderId,
            ...(primaryGift ? { giftId: primaryGift.id } : {}),
            giftTitle,
            isCustomAmount: useCustomAmount,
            quotas: useCustomAmount ? 1 : cart.reduce((a, b) => a + b.quotas, 0),
            amountCents: finalAmountCents,
            giverName: giverName.trim().slice(0, 120),
            giverContact: giverContact.trim().slice(0, 140),
            ...(messageToCouple.trim()
              ? { messageToCouple: messageToCouple.trim().slice(0, 800) }
              : {}),
            status: 'reserved',
            paymentMethod: 'demo_preview',
            orderTokenHash,
            lgpdConsent: true,
            expiresAtIso,
          },
          useCustomAmount ? [] : cart.map((c) => ({ giftId: c.gift.id, quotas: c.quotas }))
        );
      }

      const pixPayload = pixConfigured
        ? buildPixBrCode({
            pixKey: settings.pixKey,
            beneficiaryName: settings.pixBeneficiaryName || settings.coupleNames,
            city: settings.pixCity || 'Rio Pardo de Minas',
            amountCents: finalAmountCents,
            txid: orderId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20),
            description: 'Presente Dalmo e Jadi',
          })
        : null;

      setOrderSession({
        orderId,
        orderToken,
        orderTokenHash,
        amountCents: finalAmountCents,
        giftTitle,
        status: 'reserved',
        expiresAtIso,
        pixPayload,
        savedMode,
      });

      if (!useCustomAmount) {
        clearCart();
      }
    } catch (err) {
      setErrorMsg(
        'Não foi possível registrar a reserva agora. Verifique os dados e tente novamente.'
      );
      try {
        handleFirestoreError(err, OperationType.WRITE, 'gift_orders');
      } catch {
        // already logged
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyPix = async () => {
    if (!orderSession?.pixPayload) return;
    await navigator.clipboard.writeText(orderSession.pixPayload);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  const handleUploadReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderSession) return;
    setUploadingReceipt(true);
    setErrorMsg(null);

    try {
      let receiptPath = '';
      if (receiptFile) {
        if (receiptFile.size > 5 * 1024 * 1024) {
          setErrorMsg('O comprovante deve ter no máximo 5 MB.');
          setUploadingReceipt(false);
          return;
        }
        const safeName = receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (orderSession.savedMode === 'firestore') {
          const storageRef = ref(storage, `receipts/${orderSession.orderId}/${Date.now()}_${safeName}`);
          try {
            await uploadBytes(storageRef, receiptFile);
            receiptPath = storageRef.fullPath;
          } catch {
            receiptPath = `pending_manual_${safeName}`;
          }
        } else {
          receiptPath = `demo_local_${safeName}`;
        }
      }

      const noteText =
        receiptNote.trim().slice(0, 300) ||
        (receiptFile ? `Arquivo anexado: ${receiptFile.name}` : 'Informado pelo convidado');

      if (orderSession.savedMode === 'firestore') {
        const batch = writeBatch(db);
        batch.update(doc(db, 'gift_orders', orderSession.orderId), {
          status: 'awaiting_confirmation',
          receiptProofHash: orderSession.orderTokenHash,
          receiptNote: noteText,
          ...(receiptPath ? { receiptPath } : {}),
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      } else {
        demoActions.attachOrderReceipt(orderSession.orderId, noteText, receiptPath || undefined);
      }

      setOrderSession({ ...orderSession, status: 'awaiting_confirmation' });
      setReceiptSent(true);
    } catch (err) {
      setErrorMsg('Não foi possível enviar o comprovante. Tente novamente.');
      try {
        handleFirestoreError(err, OperationType.UPDATE, `gift_orders/${orderSession.orderId}`);
      } catch {
        // already logged
      }
    } finally {
      setUploadingReceipt(false);
    }
  };

  return (
    <div className="watercolor-paper py-14 sm:py-20">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <header className="text-center max-w-2xl mx-auto">
          <p className="text-xs font-semibold tracking-[0.22em] text-oliva uppercase">
            Presentear via Pix
          </p>
          <h1 className="mt-3 font-display text-4xl sm:text-5xl font-semibold text-marrom">
            Carinho em forma de presente
          </h1>
          <p className="mt-3 text-base text-marrom-suave">
            {settings.giftIntroMessage}
          </p>
        </header>

        {/* Honest Pix Integration Status Notice */}
        {!pixConfigured && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-terracota/45 bg-creme-claro p-5 text-sm text-marrom-suave">
            <AlertTriangle className="h-5 w-5 text-terracota-escuro shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-marrom">
                Modo Demonstração — Chave Pix e credenciais de webhook ainda não configuradas
              </p>
              <p className="mt-1">
                Nenhuma chave Pix fictícia é exibida e nenhum pagamento real é simulado. Os noivos
                podem cadastrar a chave Pix real depois no{' '}
                <Link to="/admin" className="font-semibold text-terracota-escuro underline">
                  Painel Administrativo
                </Link>
                . Você já pode testar o fluxo completo de reserva com status “Aguardando
                confirmação”.
              </p>
            </div>
          </div>
        )}

        {!orderSession ? (
          <form
            onSubmit={handleReserveAndGeneratePix}
            className="mt-8 space-y-6 rounded-lg border border-dourado/40 bg-creme-claro p-6 sm:p-10 shadow-sm"
          >
            {/* Mode switch: Cart vs Free Amount */}
            <div className="flex flex-wrap gap-2 border-b border-dourado/25 pb-5">
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => setUseCustomAmount(false)}
                  className={`rounded-md px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                    !useCustomAmount
                      ? 'bg-terracota-escuro text-creme-claro'
                      : 'border border-dourado/40 text-marrom hover:bg-pergaminho'
                  }`}
                >
                  Presentes da sacola ({formatBRL(cartTotalCents)})
                </button>
              )}
              <button
                type="button"
                onClick={() => setUseCustomAmount(true)}
                className={`rounded-md px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                  useCustomAmount
                    ? 'bg-terracota-escuro text-creme-claro'
                    : 'border border-dourado/40 text-marrom hover:bg-pergaminho'
                }`}
              >
                Contribuição com valor livre
              </button>
            </div>

            {!useCustomAmount && cart.length > 0 ? (
              <div className="space-y-3 rounded-md border border-dourado/25 bg-creme/60 p-4">
                <p className="text-xs font-semibold tracking-wider text-salvia uppercase">
                  Itens selecionados
                </p>
                {cart.map((item) => {
                  const isFlexible =
                    item.gift.category === 'Lua de mel' || item.gift.giftType === 'symbolic';
                  const itemTotalCents = getCartItemTotalCents(item);
                  return (
                    <div
                      key={item.gift.id}
                      className="flex items-center justify-between text-sm text-marrom"
                    >
                      <span>
                        {item.gift.title}
                        {!isFlexible ? ` (${item.quotas}x)` : ''}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {formatBRL(itemTotalCents)}
                      </span>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between border-t border-dourado/25 pt-3 text-base font-semibold text-terracota-escuro">
                  <span>Total</span>
                  <span className="tabular-nums">{formatBRL(cartTotalCents)}</span>
                </div>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="customAmount"
                  className="block text-sm font-medium text-marrom"
                >
                  Valor da contribuição (R$)
                </label>
                <input
                  id="customAmount"
                  type="text"
                  inputMode="decimal"
                  value={customAmountReais}
                  onChange={(e) => setCustomAmountReais(e.target.value)}
                  placeholder="150,00"
                  required
                  className="mt-1.5 w-full sm:w-64 rounded-md border border-dourado/45 bg-creme-claro px-4 py-2.5 text-lg font-semibold text-terracota-escuro tabular-nums focus:border-terracota-escuro focus:outline-none"
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="giverName" className="block text-sm font-medium text-marrom">
                  Seu nome completo *
                </label>
                <input
                  id="giverName"
                  type="text"
                  required
                  maxLength={120}
                  value={giverName}
                  onChange={(e) => setGiverName(e.target.value)}
                  placeholder="Ex.: Maria Oliveira"
                  className="mt-1.5 w-full rounded-md border border-dourado/45 bg-creme-claro px-3.5 py-2.5 text-sm text-marrom focus:border-terracota-escuro focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="giverContact" className="block text-sm font-medium text-marrom">
                  WhatsApp ou E-mail *
                </label>
                <input
                  id="giverContact"
                  type="text"
                  required
                  maxLength={140}
                  value={giverContact}
                  onChange={(e) => setGiverContact(e.target.value)}
                  placeholder="Ex.: (38) 99999-0000"
                  className="mt-1.5 w-full rounded-md border border-dourado/45 bg-creme-claro px-3.5 py-2.5 text-sm text-marrom focus:border-terracota-escuro focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="giftMessage" className="block text-sm font-medium text-marrom">
                Mensagem personalizada para Dalmo &amp; Jadi (opcional)
              </label>
              <textarea
                id="giftMessage"
                rows={3}
                maxLength={800}
                value={messageToCouple}
                onChange={(e) => setMessageToCouple(e.target.value)}
                placeholder="Deixe seus votos de felicidade para os noivos..."
                className="mt-1.5 w-full rounded-md border border-dourado/45 bg-creme-claro px-3.5 py-2.5 text-sm text-marrom focus:border-terracota-escuro focus:outline-none"
              />
            </div>

            <label className="flex items-start gap-3 text-xs text-marrom-suave cursor-pointer">
              <input
                type="checkbox"
                checked={lgpdConsent}
                onChange={(e) => setLgpdConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-dourado accent-terracota-escuro"
              />
              <span>
                Autorizo o uso dos meus dados exclusivamente para identificar meu presente e confirmar
                o pagamento junto aos noivos (LGPD).{' '}
                <button
                  type="button"
                  onClick={() => setPrivacyModalOpen(true)}
                  className="font-semibold text-terracota-escuro underline"
                >
                  Ler política
                </button>
              </span>
            </label>

            {errorMsg && (
              <p role="alert" className="rounded-md bg-terracota/10 px-4 py-3 text-sm text-terracota-escuro">
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-terracota-escuro px-6 py-3.5 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Registrando reserva...' : 'Reservar e gerar instruções Pix'}
            </button>
          </form>
        ) : (
          <div className="mt-8 space-y-6 rounded-lg border border-dourado/45 bg-creme-claro p-6 sm:p-10 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-dourado/25 pb-5">
              <div>
                <p className="text-xs font-semibold tracking-wider text-salvia uppercase">
                  Reserva nº {orderSession.orderId}
                  {orderSession.savedMode === 'demo' ? ' · Modo Demonstração' : ''}
                </p>
                <h2 className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-marrom">
                  {orderSession.giftTitle}
                </h2>
                <p className="mt-1 text-lg font-semibold text-terracota-escuro tabular-nums">
                  Valor: {formatBRL(orderSession.amountCents)}
                </p>
              </div>
              <div className="text-left sm:text-right">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-terracota-escuro uppercase">
                  <Clock className="h-4 w-4" />
                  Status: Aguardando confirmação
                </span>
                <p className="mt-1 text-xs text-marrom-suave">
                  Reserva válida até{' '}
                  {new Date(orderSession.expiresAtIso).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>

            {orderSession.pixPayload ? (
              <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-center">
                <div className="flex flex-col items-center justify-center rounded-lg border border-dourado/35 bg-white p-6">
                  <QRCodeSVG
                    value={orderSession.pixPayload}
                    size={210}
                    bgColor="#FFFFFF"
                    fgColor="#46352C"
                    level="M"
                  />
                  <p className="mt-3 text-xs font-medium text-marrom-suave text-center">
                    Favorecido: {settings.pixBeneficiaryName || settings.coupleNames}
                  </p>
                </div>

                <div className="space-y-4">
                  <h3 className="font-display text-xl font-semibold text-marrom flex items-center gap-2">
                    <QrCode className="h-5 w-5 text-terracota-escuro" />
                    Pix Copia e Cola
                  </h3>
                  <ol className="list-decimal list-inside space-y-1.5 text-sm text-marrom-suave">
                    <li>Abra o aplicativo do seu banco e escolha pagar via Pix.</li>
                    <li>Escaneie o QR Code ao lado ou copie o código abaixo.</li>
                    <li>Confira o nome do favorecido e o valor antes de concluir.</li>
                    <li>Após transferir, envie o comprovante abaixo (opcional) para agilizar a confirmação pelos noivos.</li>
                  </ol>

                  <div className="rounded-md border border-dourado/40 bg-creme p-3 font-mono text-xs text-marrom break-all max-h-24 overflow-y-auto">
                    {orderSession.pixPayload}
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyPix}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-terracota-escuro px-4 py-3 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota transition-colors"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Código Pix copiado!' : 'Copiar código Pix'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dourado/35 bg-creme/70 p-5 text-sm text-marrom-suave">
                <p className="font-semibold text-marrom">
                  Reserva registrada em modo demonstração
                </p>
                <p className="mt-1">
                  Como a chave Pix real ainda não foi configurada pelos noivos, nenhum QR Code de
                  pagamento é gerado. Este pedido nunca é marcado como “Pago” automaticamente e
                  permanece com status <strong>Aguardando confirmação</strong> no painel.
                </p>
              </div>
            )}

            {/* Optional private receipt upload */}
            <div className="border-t border-dourado/25 pt-6">
              <div className="flex items-center gap-2 text-sm font-semibold text-marrom">
                <Lock className="h-4 w-4 text-salvia" />
                Envio opcional de comprovante (privado)
              </div>
              <p className="mt-1 text-xs text-marrom-suave">
                {settings.pixProviderMode === 'webhook_provider'
                  ? 'Quando o provedor Pix confirmar o webhook automaticamente, seu presente será atualizado; caso queira, você também pode anexar o comprovante aqui.'
                  : 'Enviar o comprovante ajuda os noivos a conferirem o recebimento. Nenhum pagamento é aprovado automaticamente sem verificação.'}
              </p>

              {receiptSent ? (
                <div className="mt-4 rounded-md border border-salvia/40 bg-salvia/10 p-4 text-sm text-marrom">
                  <p className="font-semibold flex items-center gap-2">
                    <HeartHandshake className="h-4 w-4 text-salvia" />
                    Comprovante registrado — Status: Aguardando confirmação dos noivos
                  </p>
                  <p className="mt-1 text-xs text-marrom-suave">
                    Assim que a conferência real ocorrer após a ativação em produção, o presente
                    será marcado como confirmado.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleUploadReceipt} className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="receiptNote" className="block text-xs font-medium text-marrom">
                        Observação ou ID da transação (opcional)
                      </label>
                      <input
                        id="receiptNote"
                        type="text"
                        maxLength={300}
                        value={receiptNote}
                        onChange={(e) => setReceiptNote(e.target.value)}
                        placeholder="Ex.: Transferido pelo Banco X às 14:20"
                        className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm text-marrom"
                      />
                    </div>
                    <div>
                      <label htmlFor="receiptFile" className="block text-xs font-medium text-marrom">
                        Arquivo do comprovante (imagem ou PDF até 5 MB)
                      </label>
                      <input
                        id="receiptFile"
                        type="file"
                        accept="image/*,application/pdf"
                        onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                        className="mt-1 block w-full text-xs text-marrom-suave file:mr-3 file:rounded-md file:border file:border-dourado/40 file:bg-pergaminho file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-marrom"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={uploadingReceipt}
                    className="inline-flex items-center gap-2 rounded-md border border-terracota-escuro px-4 py-2.5 text-xs font-semibold tracking-wider text-terracota-escuro uppercase hover:bg-terracota/10 disabled:opacity-50 transition-colors"
                  >
                    <FileUp className="h-4 w-4" />
                    {uploadingReceipt ? 'Enviando...' : 'Enviar comprovante para conferência'}
                  </button>
                </form>
              )}
            </div>

            <div className="flex flex-wrap justify-between gap-3 border-t border-dourado/25 pt-5 text-xs">
              <Link to="/presentes" className="font-semibold text-marrom-suave hover:text-marrom">
                ← Voltar à lista de presentes
              </Link>
              <Link
                to={`/obrigado?pedido=${encodeURIComponent(orderSession.orderId)}&status=${orderSession.status}`}
                className="font-semibold text-terracota-escuro hover:underline"
              >
                Ver resumo do pedido →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
