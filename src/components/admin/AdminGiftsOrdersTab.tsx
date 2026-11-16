import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Check,
  Database,
  Edit3,
  Eye,
  EyeOff,
  Lock,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  deleteDoc,
  doc,
  increment,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { isBundledGiftImageUrl, useWedding } from '../../context/WeddingContext';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { formatBRL, generateRandomToken } from '../../lib/pix';
import { GiftCategory, GiftItem, GiftOrder, GiftType } from '../../types/wedding';
import { GIFT_IMAGES } from '../../data/giftImages';
import { OFFICIAL_GIFTS } from '../../data/defaults';
import { ResilientImage } from '../ResilientImage';
import {
  AppliedGiftPhotoPayload,
  GiftPhotoSearchModal,
} from './GiftPhotoSearchModal';
import { LegacyGalleryCleanupModal } from './LegacyGalleryCleanupModal';

const ARTIFICIAL_LEGACY_IMAGE_RE = /gift_[a-z0-9_]+_1794802/i;

function isGiftPhotoArtificialOrPending(g: GiftItem): boolean {
  return Boolean(g.needsPhotoReview || ARTIFICIAL_LEGACY_IMAGE_RE.test(g.imageUrl || ''));
}

const CATEGORIES: GiftCategory[] = [
  'Cozinha & Mesa',
  'Cama, Mesa & Banho',
  'Eletrodomésticos',
  'Decoração & Conforto',
  'Momentos a dois',
  'Lua de mel',
  'Contribuições especiais',
];

export const AdminGiftsOrdersTab: React.FC = () => {
  const {
    gifts,
    giftOrders,
    user,
    demoAdminActive,
    isAdmin,
    demoActions,
    syncOfficialCatalog,
    deleteAdminGiftOrder,
    seeding,
  } = useWedding();
  const [orderToDelete, setOrderToDelete] = useState<GiftOrder | null>(null);
  const [deletingOrder, setDeletingOrder] = useState(false);
  const [orderDeleteError, setOrderDeleteError] = useState<string | null>(null);
  const [orderActionFeedback, setOrderActionFeedback] = useState<string | null>(null);
  const [editingGift, setEditingGift] = useState<GiftItem | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<GiftCategory>('Cozinha & Mesa');
  const [priceReais, setPriceReais] = useState('150,00');
  const [giftType, setGiftType] = useState<GiftType>('full');
  const [desiredUnits, setDesiredUnits] = useState(1);
  const [quotasPerUnit, setQuotasPerUnit] = useState(1);
  const [imageUrl, setImageUrl] = useState<string>(GIFT_IMAGES.gift01CookwareSet);
  const [photoSource, setPhotoSource] = useState<string | undefined>(undefined);
  const [needsPhotoReview, setNeedsPhotoReview] = useState(false);
  const [initialPhotoBackup, setInitialPhotoBackup] = useState<{
    imageUrl: string;
    photoSource?: string;
    needsPhotoReview: boolean;
  } | null>(null);
  const [showPhotoSearchModal, setShowPhotoSearchModal] = useState(false);
  const [showLegacyCleanupModal, setShowLegacyCleanupModal] = useState(false);
  const [uploadingManualInline, setUploadingManualInline] = useState(false);
  const [photoFeedback, setPhotoFeedback] = useState<string | null>(null);
  const manualUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [featured, setFeatured] = useState(false);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [filterAdminCategory, setFilterAdminCategory] = useState<'Todos' | GiftCategory>('Todos');
  const [filterOnlyNeedsReview, setFilterOnlyNeedsReview] = useState(false);

  const useDemoStore = demoAdminActive || !isAdmin;
  const isAuthenticatedAdmin = Boolean(user && user.emailVerified && isAdmin && !demoAdminActive);

  const visibleGiftOrders = useMemo(
    () => giftOrders.filter((ord) => !ord.adminArchived),
    [giftOrders]
  );

  useEffect(() => {
    if (!orderToDelete) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deletingOrder) {
        setOrderToDelete(null);
        setOrderDeleteError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [orderToDelete, deletingOrder]);

  const missingOfficialCount = useMemo(() => {
    const existingIds = new Set(gifts.map((g) => g.id));
    return OFFICIAL_GIFTS.filter((o) => !existingIds.has(o.id)).length;
  }, [gifts]);

  const outdatedOfficialPhotosCount = useMemo(() => {
    const officialById = new Map(OFFICIAL_GIFTS.map((o) => [o.id, o]));
    let count = 0;
    for (const g of gifts) {
      const official = officialById.get(g.id);
      if (
        official &&
        isBundledGiftImageUrl(g.imageUrl) &&
        (g.imageUrl !== official.imageUrl ||
          g.needsPhotoReview !== official.needsPhotoReview ||
          g.photoSource !== official.photoSource)
      ) {
        count += 1;
      }
    }
    return count;
  }, [gifts]);

  const syncActionCount = missingOfficialCount + outdatedOfficialPhotosCount;

  const needsReviewCount = useMemo(
    () => gifts.filter((g) => isGiftPhotoArtificialOrPending(g)).length,
    [gifts]
  );

  const displayedGifts = useMemo(() => {
    return gifts.filter((g) => {
      if (filterOnlyNeedsReview && !isGiftPhotoArtificialOrPending(g)) return false;
      if (filterAdminCategory !== 'Todos' && g.category !== filterAdminCategory) return false;
      return true;
    });
  }, [gifts, filterAdminCategory, filterOnlyNeedsReview]);

  const logAction = async (action: string, details: string) => {
    if (useDemoStore || !user) return;
    await setDoc(doc(db, 'admin_logs', `log_${generateRandomToken(6)}`), {
      actorUid: user.uid,
      actorEmail: user.email || '',
      action,
      details: details.slice(0, 500),
      createdAt: serverTimestamp(),
    });
  };

  const openCreateForm = () => {
    setFormError(null);
    setPhotoFeedback(null);
    setEditingGift(null);
    setTitle('');
    setDescription('');
    setCategory('Cozinha & Mesa');
    setPriceReais('150,00');
    setGiftType('full');
    setDesiredUnits(1);
    setQuotasPerUnit(1);
    setImageUrl(GIFT_IMAGES.gift01CookwareSet);
    setPhotoSource(undefined);
    setNeedsPhotoReview(false);
    setInitialPhotoBackup(null);
    setFeatured(false);
    setActive(true);
    setShowNewForm(true);
  };

  const openEditForm = (g: GiftItem) => {
    setFormError(null);
    setPhotoFeedback(null);
    setEditingGift(g);
    setTitle(g.title);
    setDescription(g.description);
    setCategory(g.category);
    setPriceReais((g.priceCents / 100).toFixed(2).replace('.', ','));
    setGiftType(g.giftType);
    const units = g.desiredUnits && g.desiredUnits > 1 ? g.desiredUnits : 1;
    const perUnit =
      g.quotasPerUnit && g.quotasPerUnit >= 1
        ? g.quotasPerUnit
        : Math.max(1, Math.round(g.totalQuotas / units));
    setDesiredUnits(units);
    setQuotasPerUnit(perUnit);
    const currentUrl = g.imageUrl || GIFT_IMAGES.gift01CookwareSet;
    setImageUrl(currentUrl);
    setPhotoSource(g.photoSource);
    setNeedsPhotoReview(Boolean(g.needsPhotoReview));
    setInitialPhotoBackup({
      imageUrl: currentUrl,
      photoSource: g.photoSource,
      needsPhotoReview: Boolean(g.needsPhotoReview),
    });
    setFeatured(g.featured);
    setActive(g.active);
    setShowNewForm(true);
  };

  const applyPhotoPayload = async (payload: AppliedGiftPhotoPayload) => {
    const cleanUrl = payload.imageUrl.trim().slice(0, 600);
    const cleanSource = payload.photoSource.trim().slice(0, 160);
    setImageUrl(cleanUrl);
    setPhotoSource(cleanSource);
    setNeedsPhotoReview(payload.needsPhotoReview);
    setPhotoFeedback('Fotografia atualizada no cartão do presente.');

    if (editingGift) {
      const updatedGift: GiftItem = {
        ...editingGift,
        imageUrl: cleanUrl,
        photoSource: cleanSource,
        needsPhotoReview: payload.needsPhotoReview,
      };
      setEditingGift(updatedGift);
      if (useDemoStore) {
        demoActions.saveGift(updatedGift);
      } else {
        await setDoc(
          doc(db, 'gifts', editingGift.id),
          {
            imageUrl: cleanUrl,
            photoSource: cleanSource,
            needsPhotoReview: payload.needsPhotoReview,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        await logAction('Fotografia do presente atualizada', `${editingGift.title} (${cleanSource})`);
      }
    }
  };

  const handleRestorePreviousPhoto = async () => {
    if (!initialPhotoBackup) return;
    const restoredUrl = initialPhotoBackup.imageUrl;
    const restoredSource = initialPhotoBackup.photoSource;
    const restoredReview = initialPhotoBackup.needsPhotoReview;

    setImageUrl(restoredUrl);
    setPhotoSource(restoredSource);
    setNeedsPhotoReview(restoredReview);
    setPhotoFeedback('Imagem anterior restaurada com sucesso.');

    if (editingGift) {
      const updatedGift: GiftItem = {
        ...editingGift,
        imageUrl: restoredUrl,
        ...(restoredSource ? { photoSource: restoredSource } : { photoSource: undefined }),
        needsPhotoReview: restoredReview,
      };
      setEditingGift(updatedGift);
      if (useDemoStore) {
        demoActions.saveGift(updatedGift);
      } else {
        await setDoc(
          doc(db, 'gifts', editingGift.id),
          {
            imageUrl: restoredUrl,
            photoSource: restoredSource || '',
            needsPhotoReview: restoredReview,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        await logAction('Fotografia anterior restaurada', editingGift.title);
      }
    }
  };

  const handleInlineManualUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type)) {
      setFormError('Envie uma imagem válida no formato JPG, PNG ou WEBP.');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setFormError('A imagem selecionada excede o limite de 12 MB.');
      return;
    }

    setUploadingManualInline(true);
    setFormError(null);
    try {
      const res = await fetch('/api/media/gifts', {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Não foi possível salvar o upload manual.');
      }
      await applyPhotoPayload({
        imageUrl: data.url,
        photoSource: 'Upload manual no painel administrativo',
        needsPhotoReview: false,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao enviar imagem manual.');
    } finally {
      setUploadingManualInline(false);
    }
  };

  const parsedPriceCents = useMemo(() => {
    const num = Number.parseFloat(priceReais.replace(/[^\d,]/g, '').replace(',', '.'));
    if (Number.isNaN(num) || num < 1) return 100;
    return Math.round(num * 100);
  }, [priceReais]);

  const isFlexibleForm = category === 'Lua de mel' || giftType === 'symbolic';
  const computedTotalQuotas = isFlexibleForm
    ? Math.max(1, Math.min(1000, Number(quotasPerUnit) || 1))
    : Math.max(1, (Number(desiredUnits) || 1) * (Number(quotasPerUnit) || 1));

  const handleSaveGift = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (editingGift) {
      const lockedQuotas = (editingGift.paidQuotas || 0) + (editingGift.reservedQuotas || 0);
      if (computedTotalQuotas < lockedQuotas) {
        setFormError(
          isFlexibleForm
            ? `Não é possível reduzir a disponibilidade para ${computedTotalQuotas}: já existem ${lockedQuotas} contribuições registradas (${editingGift.paidQuotas} confirmada(s) e ${editingGift.reservedQuotas} reservada(s)).`
            : `Não é possível reduzir para ${computedTotalQuotas} cota(s): já existem ${editingGift.paidQuotas} cota(s) paga(s) e ${editingGift.reservedQuotas} reservada(s) (${lockedQuotas} no total).`
        );
        return;
      }
    }

    setSaving(true);
    try {
      const id = editingGift ? editingGift.id : `gift_${generateRandomToken(6)}`;
      const nextSortOrder =
        editingGift?.sortOrder ??
        gifts.reduce((max, item) => Math.max(max, item.sortOrder ?? 0), 0) + 1;

      const resolvedGiftType: GiftType =
        computedTotalQuotas > 1 && giftType === 'full' ? 'quota' : giftType;

      const trimmedImageUrl = imageUrl.trim().slice(0, 600);
      const imageChanged = editingGift
        ? trimmedImageUrl !== (editingGift.imageUrl || '').trim()
        : true;
      const matchingOfficial = OFFICIAL_GIFTS.find((o) => o.imageUrl === trimmedImageUrl);
      const resolvedNeedsPhotoReview = matchingOfficial
        ? Boolean(matchingOfficial.needsPhotoReview)
        : imageChanged
          ? needsPhotoReview
          : Boolean(editingGift?.needsPhotoReview);
      const resolvedPhotoSource = (
        photoSource ||
        matchingOfficial?.photoSource ||
        (imageChanged ? 'Foto personalizada (Admin)' : editingGift?.photoSource)
      )?.slice(0, 160);

      const giftPayload: GiftItem = {
        id,
        title: title.trim().slice(0, 140),
        description: description.trim().slice(0, 500),
        category,
        priceCents: parsedPriceCents,
        imageUrl: trimmedImageUrl,
        giftType: resolvedGiftType,
        totalQuotas: computedTotalQuotas,
        ...(desiredUnits > 1
          ? { desiredUnits: Math.max(1, Number(desiredUnits) || 1), quotasPerUnit: Math.max(1, Number(quotasPerUnit) || 1) }
          : {}),
        reservedQuotas: editingGift ? editingGift.reservedQuotas : 0,
        paidQuotas: editingGift ? editingGift.paidQuotas : 0,
        sortOrder: nextSortOrder,
        active,
        featured,
        isDemoExample: false,
        needsPhotoReview: resolvedNeedsPhotoReview,
        ...(resolvedPhotoSource ? { photoSource: resolvedPhotoSource } : {}),
      };

      if (useDemoStore) {
        demoActions.saveGift(giftPayload);
      } else {
        const now = serverTimestamp();
        const { id: _id, ...rest } = giftPayload;
        await setDoc(
          doc(db, 'gifts', id),
          {
            ...rest,
            isDemoExample: false,
            createdAt: editingGift?.createdAt || now,
            updatedAt: now,
          },
          { merge: true }
        );
        await logAction(editingGift ? 'Presente editado' : 'Presente criado', title);
      }
      setShowNewForm(false);
      setEditingGift(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'gifts');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (g: GiftItem) => {
    const updated: GiftItem = { ...g, active: !g.active };
    if (useDemoStore) {
      demoActions.saveGift(updated);
      return;
    }
    try {
      await setDoc(
        doc(db, 'gifts', g.id),
        { active: !g.active, updatedAt: serverTimestamp() },
        { merge: true }
      );
      await logAction(
        !g.active ? 'Presente exibido' : 'Presente ocultado',
        g.title
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `gifts/${g.id}`);
    }
  };

  const handleMoveGift = async (indexInFullList: number, direction: -1 | 1) => {
    const targetIdx = indexInFullList + direction;
    if (targetIdx < 0 || targetIdx >= gifts.length) return;

    const ordered = [...gifts];
    const [moved] = ordered.splice(indexInFullList, 1);
    ordered.splice(targetIdx, 0, moved);
    const orderedIds = ordered.map((item) => item.id);

    if (useDemoStore) {
      demoActions.reorderGifts(orderedIds);
      return;
    }

    try {
      const batch = writeBatch(db);
      const now = serverTimestamp();
      ordered.forEach((item, idx) => {
        batch.update(doc(db, 'gifts', item.id), {
          sortOrder: idx + 1,
          updatedAt: now,
        });
      });
      await batch.commit();
      await logAction('Ordem de presentes atualizada', moved.title);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'gifts');
    }
  };

  const handleDeleteGift = async (g: GiftItem) => {
    if (g.paidQuotas > 0 || g.reservedQuotas > 0) return;
    if (useDemoStore) {
      demoActions.deleteGift(g.id);
      return;
    }
    try {
      await deleteDoc(doc(db, 'gifts', g.id));
      await logAction('Presente removido', g.title);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `gifts/${g.id}`);
    }
  };

  const handleSyncCatalog = async () => {
    setSyncFeedback(null);
    const res = await syncOfficialCatalog();
    setSyncFeedback(
      `Sincronização concluída: ${res.added} adicionado(s), ${res.updatedPhotos} foto(s) atualizada(s) e ${res.removedPlaceholders} rascunho(s) antigo(s) removido(s).`
    );
  };

  const handleConfirmOrder = async (orderId: string, giftId?: string, quotas = 1) => {
    // Nunca confirmar presentes como pagos em modo demonstração
    if (useDemoStore) return;
    try {
      const batch = writeBatch(db);
      const now = serverTimestamp();
      batch.update(doc(db, 'gift_orders', orderId), {
        status: 'confirmed',
        confirmedAtIso: new Date().toISOString(),
        updatedAt: now,
      });
      if (giftId && !giftId.startsWith('demo-')) {
        batch.update(doc(db, 'gifts', giftId), {
          reservedQuotas: increment(-quotas),
          paidQuotas: increment(quotas),
          updatedAt: now,
        });
      }
      await batch.commit();
      await logAction('Pagamento Pix confirmado', `Pedido ${orderId}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `gift_orders/${orderId}`);
    }
  };

  const handleCancelOrder = async (
    orderId: string,
    newStatus: 'expired' | 'cancelled',
    giftId?: string,
    quotas = 1
  ) => {
    if (useDemoStore) {
      demoActions.cancelGiftOrder(orderId, newStatus);
      return;
    }
    try {
      const batch = writeBatch(db);
      const now = serverTimestamp();
      batch.update(doc(db, 'gift_orders', orderId), {
        status: newStatus,
        updatedAt: now,
      });
      if (giftId && !giftId.startsWith('demo-')) {
        batch.update(doc(db, 'gifts', giftId), {
          reservedQuotas: increment(-quotas),
          updatedAt: now,
        });
      }
      await batch.commit();
      await logAction('Reserva encerrada', `Pedido ${orderId} -> ${newStatus}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `gift_orders/${orderId}`);
    }
  };

  const handleConfirmDeleteOrder = async () => {
    if (!orderToDelete || !isAuthenticatedAdmin || deletingOrder) return;
    setDeletingOrder(true);
    setOrderDeleteError(null);
    setOrderActionFeedback(null);
    try {
      const result = await deleteAdminGiftOrder(orderToDelete.id);
      setOrderToDelete(null);
      setOrderActionFeedback(
        result.mode === 'archived'
          ? 'Registro ocultado do histórico administrativo com preservação dos dados financeiros e comprovantes.'
          : 'Registro excluído do histórico administrativo.'
      );
    } catch (err) {
      setOrderDeleteError(
        err instanceof Error ? err.message : 'Não foi possível excluir este registro.'
      );
    } finally {
      setDeletingOrder(false);
    }
  };

  return (
    <div className="space-y-10">
      <section className="rounded-lg border border-dourado/35 bg-creme-claro p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-marrom">
              Reservas &amp; Contribuições Pix ({visibleGiftOrders.length})
            </h2>
            <p className="mt-1 text-xs text-marrom-suave">
              {useDemoStore
                ? 'Modo demonstração: reservas permanecem como "Aguardando confirmação". A confirmação como pago fica bloqueada até ativar o modo de produção.'
                : 'Confirme somente após conferir o recebimento real na conta bancária ou via webhook.'}
            </p>
          </div>
          {useDemoStore && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-terracota-escuro">
              <Lock className="h-3.5 w-3.5" />
              Pagamentos não simulados
            </span>
          )}
        </div>

        {orderActionFeedback && (
          <p className="mt-4 rounded-md border border-oliva/40 bg-oliva/10 px-4 py-2.5 text-xs text-marrom">
            {orderActionFeedback}
          </p>
        )}

        {visibleGiftOrders.length === 0 ? (
          <p className="mt-6 text-sm text-marrom-suave">
            Nenhum pedido de presente registrado até o momento.
          </p>
        ) : (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-dourado/25 text-xs uppercase text-marrom-suave">
                  <th className="py-2 pr-4">Convidado</th>
                  <th className="py-2 pr-4">Presente</th>
                  <th className="py-2 pr-4">Valor</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Comprovante / Msg</th>
                  <th className="py-2 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dourado/15">
                {visibleGiftOrders.map((ord) => (
                  <tr key={ord.id}>
                    <td className="py-3 pr-3 sm:pr-4">
                      <p className="font-medium text-marrom">{ord.giverName}</p>
                      <p className="text-xs text-marrom-suave">{ord.giverContact}</p>
                    </td>
                    <td className="py-3 pr-3 sm:pr-4 text-marrom">{ord.giftTitle}</td>
                    <td className="py-3 pr-3 sm:pr-4 font-semibold text-terracota-escuro tabular-nums whitespace-nowrap">
                      {formatBRL(ord.amountCents)}
                    </td>
                    <td className="py-3 pr-3 sm:pr-4 text-xs font-medium">
                      {ord.status === 'confirmed' && (
                        <span className="text-salvia">Confirmado</span>
                      )}
                      {ord.status === 'awaiting_confirmation' && (
                        <span className="text-terracota-escuro">Aguardando confirmação</span>
                      )}
                      {ord.status === 'reserved' && (
                        <span className="text-marrom-suave">Reservado</span>
                      )}
                      {(ord.status === 'expired' || ord.status === 'cancelled') && (
                        <span className="text-marrom-suave/70">
                          {ord.status === 'expired' ? 'Expirado' : 'Cancelado'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-3 sm:pr-4 text-xs text-marrom-suave max-w-xs">
                      {ord.receiptNote && <p>Nota: {ord.receiptNote}</p>}
                      {ord.messageToCouple && <p className="italic">“{ord.messageToCouple}”</p>}
                    </td>
                    <td className="py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5 sm:gap-2">
                        {(ord.status === 'reserved' || ord.status === 'awaiting_confirmation') && (
                          <>
                            <button
                              type="button"
                              disabled={useDemoStore}
                              title={
                                useDemoStore
                                  ? 'Indisponível no modo demonstração (não simulamos pagamentos)'
                                  : 'Confirmar recebimento Pix real'
                              }
                              onClick={() =>
                                handleConfirmOrder(
                                  ord.id,
                                  ord.isCustomAmount ? undefined : ord.giftId,
                                  ord.quotas
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-md bg-salvia px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Confirmar Pix
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleCancelOrder(
                                  ord.id,
                                  'cancelled',
                                  ord.isCustomAmount ? undefined : ord.giftId,
                                  ord.quotas
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-dourado/40 px-2.5 py-1.5 text-xs text-marrom-suave hover:text-terracota-escuro"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Cancelar
                            </button>
                          </>
                        )}
                        {isAuthenticatedAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setOrderDeleteError(null);
                              setOrderToDelete(ord);
                            }}
                            title="Excluir registro"
                            aria-label={`Excluir registro de ${ord.giverName}`}
                            className="inline-flex h-8 w-8 md:h-auto md:w-auto items-center justify-center gap-1 rounded-md border border-terracota/55 bg-terracota/10 md:px-2.5 md:py-1.5 text-xs font-semibold text-terracota-escuro hover:bg-terracota-escuro hover:text-creme-claro transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            <span className="hidden md:inline">Excluir</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-dourado/35 bg-creme-claro p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-marrom">
              Catálogo de Presentes ({gifts.length})
            </h2>
            <p className="text-xs text-marrom-suave">
              Adicione, edite valores, unidades, cotas, oculte, reordene ou altere imagens sem
              comprometer reservas existentes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {!useDemoStore && syncActionCount > 0 && (
              <button
                type="button"
                disabled={seeding}
                onClick={handleSyncCatalog}
                className="inline-flex items-center gap-2 rounded-md border border-oliva/60 bg-oliva/10 px-4 py-2 text-xs font-semibold text-oliva uppercase hover:bg-oliva/20 disabled:opacity-50"
              >
                <Database className="h-4 w-4" />
                {seeding
                  ? 'Sincronizando...'
                  : `Sincronizar catálogo oficial (${syncActionCount})`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowLegacyCleanupModal(true)}
              className="inline-flex items-center gap-2 rounded-md border border-dourado/60 bg-creme px-4 py-2 text-xs font-semibold text-marrom uppercase hover:bg-pergaminho"
            >
              <Trash2 className="h-4 w-4 text-terracota-escuro" />
              LIMPAR GALERIA ANTIGA
            </button>
            <button
              type="button"
              onClick={openCreateForm}
              className="inline-flex items-center gap-2 rounded-md bg-terracota-escuro px-4 py-2 text-xs font-semibold text-creme-claro uppercase hover:bg-terracota"
            >
              <Plus className="h-4 w-4" />
              Novo presente
            </button>
          </div>
        </div>

        {syncFeedback && (
          <p className="mt-4 rounded-md border border-oliva/40 bg-oliva/10 px-4 py-2.5 text-xs text-marrom">
            {syncFeedback}
          </p>
        )}

        {needsReviewCount > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dourado/55 bg-creme px-4 py-2.5 text-xs text-marrom">
            <span className="inline-flex items-center gap-2">
              <Camera className="h-4 w-4 shrink-0 text-terracota-escuro" />
              <span>
                <strong>{needsReviewCount}</strong> presente(s) utilizam imagem ilustrativa preservada e aguardam revisão por fotografia real.
              </span>
            </span>
            <button
              type="button"
              onClick={() => setFilterOnlyNeedsReview((prev) => !prev)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                filterOnlyNeedsReview
                  ? 'bg-terracota-escuro text-creme-claro'
                  : 'border border-terracota/40 text-terracota-escuro hover:bg-terracota/10'
              }`}
            >
              {filterOnlyNeedsReview ? 'Mostrar todos' : 'Filtrar pendentes'}
            </button>
          </div>
        )}

        {/* Filtro rápido por categoria no Admin */}
        <div className="mt-4 flex flex-wrap gap-2">
          {(['Todos', ...CATEGORIES] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setFilterAdminCategory(cat)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                filterAdminCategory === cat
                  ? 'bg-terracota-escuro text-creme-claro'
                  : 'border border-dourado/40 bg-creme text-marrom hover:bg-pergaminho'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {showNewForm && (
          <form
            onSubmit={handleSaveGift}
            className="mt-6 space-y-4 rounded-md border border-dourado/40 bg-creme/70 p-5"
          >
            <h3 className="font-display text-xl font-semibold text-marrom">
              {editingGift ? `Editar presente — ${editingGift.title}` : 'Cadastrar presente'}
            </h3>

            {editingGift?.needsPhotoReview && (
              <p className="rounded-md border border-terracota/35 bg-terracota/10 px-3.5 py-2 text-xs text-terracota-escuro">
                Este item está marcado para revisão de fotografia. Ao informar uma nova URL de foto real e salvar, a pendência será removida automaticamente.
              </p>
            )}

            {editingGift && (editingGift.paidQuotas > 0 || editingGift.reservedQuotas > 0) && (
              <p className="rounded-md border border-dourado/45 bg-creme-claro px-3.5 py-2 text-xs text-marrom-suave">
                Atenção: este item possui{' '}
                <strong className="text-marrom">{editingGift.paidQuotas} cota(s) paga(s)</strong> e{' '}
                <strong className="text-marrom">
                  {editingGift.reservedQuotas} reservada(s)
                </strong>
                . O total de cotas não pode ficar abaixo de{' '}
                {editingGift.paidQuotas + editingGift.reservedQuotas}.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-marrom">Nome *</label>
                <input
                  type="text"
                  required
                  maxLength={140}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-marrom">Categoria *</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as GiftCategory)}
                  className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-marrom">
                  {isFlexibleForm ? 'Valor sugerido (R$) *' : 'Valor por cota (R$) *'}
                </label>
                <input
                  type="text"
                  required
                  value={priceReais}
                  onChange={(e) => setPriceReais(e.target.value)}
                  className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm tabular-nums"
                />
              </div>
              {isFlexibleForm ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-marrom">Tipo</label>
                    <select
                      value={giftType}
                      onChange={(e) => setGiftType(e.target.value as GiftType)}
                      className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-2.5 py-2 text-sm"
                    >
                      <option value="symbolic">Contribuição flexível</option>
                      <option value="full">Único</option>
                      <option value="quota">Dividido</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-marrom">
                      Disponibilidade
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={quotasPerUnit}
                      onChange={(e) => {
                        setDesiredUnits(1);
                        setQuotasPerUnit(Math.max(1, Math.min(1000, Number(e.target.value) || 1)));
                      }}
                      className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-2.5 py-2 text-sm tabular-nums"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-marrom">Tipo</label>
                    <select
                      value={giftType}
                      onChange={(e) => setGiftType(e.target.value as GiftType)}
                      className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-2.5 py-2 text-sm"
                    >
                      <option value="full">Único</option>
                      <option value="quota">Cotas</option>
                      <option value="symbolic">Contribuição flexível</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-marrom">Unidades</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={desiredUnits}
                      onChange={(e) => setDesiredUnits(Math.max(1, Number(e.target.value) || 1))}
                      className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-2.5 py-2 text-sm tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-marrom">Cotas/unid.</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={quotasPerUnit}
                      onChange={(e) => setQuotasPerUnit(Math.max(1, Number(e.target.value) || 1))}
                      className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-2.5 py-2 text-sm tabular-nums"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border border-dourado/30 bg-creme-claro/80 px-3.5 py-2 text-xs text-marrom-suave flex flex-wrap gap-x-5 gap-y-1">
              {isFlexibleForm ? (
                <>
                  <span>
                    Disponibilidade:{' '}
                    <strong className="text-marrom">{computedTotalQuotas} contribuições</strong>
                  </span>
                  <span>
                    Valor sugerido:{' '}
                    <strong className="text-terracota-escuro">
                      {formatBRL(parsedPriceCents)}
                    </strong>
                  </span>
                </>
              ) : (
                <>
                  <span>
                    Total de cotas: <strong className="text-marrom">{computedTotalQuotas}</strong>
                  </span>
                  {desiredUnits > 1 && (
                    <span>
                      Valor unitário:{' '}
                      <strong className="text-marrom">
                        {formatBRL(parsedPriceCents * Math.max(1, quotasPerUnit))}
                      </strong>
                    </span>
                  )}
                  <span>
                    Valor total do presente:{' '}
                    <strong className="text-terracota-escuro">
                      {formatBRL(parsedPriceCents * computedTotalQuotas)}
                    </strong>
                  </span>
                </>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-marrom">Descrição breve *</label>
              <textarea
                rows={2}
                required
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
              />
            </div>

            {/* Ferramenta: Buscar fotos reais de produtos comerciais */}
            <div className="rounded-md border border-dourado/40 bg-creme-claro/90 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-16 w-20 shrink-0 overflow-hidden rounded border border-dourado/35 bg-pergaminho">
                    <ResilientImage
                      key={imageUrl}
                      src={imageUrl}
                      alt={title || 'Prévia do presente'}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-marrom">
                      Fotografia real do produto
                    </p>
                    <p className="mt-0.5 text-[11px] text-marrom-suave truncate">
                      {photoSource || 'Consulte catálogos comerciais oficiais ou envie uma foto do produto'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFormError(null);
                      setShowPhotoSearchModal(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-terracota-escuro px-3.5 py-2 text-xs font-semibold uppercase text-creme-claro hover:bg-terracota shadow-xs"
                  >
                    <Search className="h-3.5 w-3.5" />
                    BUSCAR FOTOS REAIS
                  </button>

                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setFormError(null);
                        setShowPhotoSearchModal(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-dourado/55 bg-creme px-3 py-2 text-xs font-semibold uppercase text-marrom hover:bg-pergaminho"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      SUBSTITUIR FOTO
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={uploadingManualInline}
                    onClick={() => manualUploadInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-dourado/55 bg-creme px-3 py-2 text-xs font-semibold uppercase text-marrom hover:bg-pergaminho disabled:opacity-60"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {uploadingManualInline ? 'Enviando...' : 'ENVIAR MINHA FOTO'}
                  </button>
                  <input
                    ref={manualUploadInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleInlineManualUpload}
                    className="hidden"
                  />

                  {initialPhotoBackup &&
                    (imageUrl.trim() !== initialPhotoBackup.imageUrl.trim() ||
                      (photoSource || '') !== (initialPhotoBackup.photoSource || '')) && (
                      <button
                        type="button"
                        onClick={handleRestorePreviousPhoto}
                        className="inline-flex items-center gap-1.5 rounded-md border border-dourado/55 bg-creme px-3 py-2 text-xs font-semibold uppercase text-marrom hover:bg-pergaminho"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        RESTAURAR FOTO ANTERIOR
                      </button>
                    )}
                </div>
              </div>

              {photoFeedback && (
                <p className="rounded border border-oliva/40 bg-oliva/10 px-3 py-1.5 text-xs text-marrom">
                  {photoFeedback}
                </p>
              )}

              <div>
                <label className="block text-xs font-medium text-marrom">
                  URL verificada da fotografia do produto
                </label>
                <input
                  type="text"
                  maxLength={600}
                  value={imageUrl}
                  onChange={(e) => {
                    setImageUrl(e.target.value);
                    setPhotoSource('URL personalizada (Admin)');
                    setNeedsPhotoReview(false);
                  }}
                  className="mt-1 w-full rounded-md border border-dourado/40 bg-creme-claro px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-5 text-xs text-marrom">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                Visível na lista pública
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={featured}
                  onChange={(e) => setFeatured(e.target.checked)}
                />
                Destacar na ordenação principal
              </label>
            </div>

            {formError && (
              <p role="alert" className="rounded-md bg-terracota/10 px-3.5 py-2.5 text-xs text-terracota-escuro">
                {formError}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving}
                className="rounded-md bg-terracota-escuro px-4 py-2 text-xs font-semibold text-creme-claro uppercase"
              >
                {saving ? 'Salvando...' : 'Salvar presente'}
              </button>
              <button
                type="button"
                onClick={() => setShowNewForm(false)}
                className="rounded-md border border-dourado/40 px-4 py-2 text-xs text-marrom"
              >
                Cancelar
              </button>
            </div>
          </form>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {displayedGifts.map((g) => {
            const fullIndex = gifts.findIndex((item) => item.id === g.id);
            const totalCents = g.priceCents * g.totalQuotas;
            const locked = g.paidQuotas > 0 || g.reservedQuotas > 0;
            return (
              <div
                key={g.id}
                className={`flex items-center justify-between gap-3 rounded-md border p-3.5 transition-colors ${
                  g.active
                    ? 'border-dourado/30 bg-creme/45'
                    : 'border-dourado/20 bg-pergaminho/40 opacity-75'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-14 w-[74px] shrink-0 overflow-hidden rounded border border-dourado/30 bg-pergaminho">
                    <ResilientImage
                      key={g.imageUrl}
                      src={g.imageUrl}
                      alt={g.title}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-marrom-suave">
                      <span className="truncate">
                        {g.category === 'Lua de mel' || g.giftType === 'symbolic'
                          ? `${g.category === 'Lua de mel' ? 'Lua de Mel' : g.category} · ${g.paidQuotas} confirmada(s) (${g.reservedQuotas} reserv.) · disp. ${g.totalQuotas}`
                          : `${g.category} · ${g.paidQuotas}/${g.totalQuotas} pagas (${g.reservedQuotas} reserv.)`}
                        {!g.active ? ' · Oculto' : ''}
                      </span>
                      {isGiftPhotoArtificialOrPending(g) && (
                        <span className="inline-flex items-center gap-1 rounded border border-terracota/40 bg-terracota/10 px-1.5 py-0.5 text-[10px] font-semibold text-terracota-escuro">
                          <Camera className="h-3 w-3" />
                          Substituir foto artificial
                        </span>
                      )}
                    </div>
                    <p className="font-display text-lg font-semibold text-marrom truncate">
                      {g.title}
                    </p>
                    <p className="text-xs font-semibold text-terracota-escuro tabular-nums">
                      {g.category === 'Lua de mel' || g.giftType === 'symbolic'
                        ? `Valor sugerido: ${formatBRL(g.priceCents)} · Contribuição flexível`
                        : g.totalQuotas > 1
                          ? `${formatBRL(g.priceCents)} / cota · Total ${formatBRL(totalCents)}`
                          : formatBRL(g.priceCents)}
                      {g.category !== 'Lua de mel' &&
                      g.giftType !== 'symbolic' &&
                      g.desiredUnits &&
                      g.desiredUnits > 1
                        ? ` · ${g.desiredUnits} unid.`
                        : ''}
                    </p>
                    {g.photoSource && (
                      <p className="mt-0.5 text-[10px] text-marrom-suave/80 truncate">
                        Foto: {g.photoSource}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {filterAdminCategory === 'Todos' && !filterOnlyNeedsReview && (
                    <>
                      <button
                        type="button"
                        disabled={fullIndex <= 0}
                        onClick={() => handleMoveGift(fullIndex, -1)}
                        aria-label={`Mover ${g.title} para cima`}
                        title="Mover para cima"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dourado/40 text-marrom hover:bg-pergaminho disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={fullIndex >= gifts.length - 1}
                        onClick={() => handleMoveGift(fullIndex, 1)}
                        aria-label={`Mover ${g.title} para baixo`}
                        title="Mover para baixo"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dourado/40 text-marrom hover:bg-pergaminho disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleToggleActive(g)}
                    aria-label={g.active ? `Ocultar ${g.title}` : `Exibir ${g.title}`}
                    title={g.active ? 'Ocultar na lista' : 'Exibir na lista'}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dourado/40 text-marrom hover:bg-pergaminho"
                  >
                    {g.active ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditForm(g)}
                    aria-label={`Editar ${g.title}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dourado/40 text-marrom hover:bg-pergaminho"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  {!locked && (
                    <button
                      type="button"
                      onClick={() => handleDeleteGift(g)}
                      aria-label={`Excluir ${g.title}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-dourado/40 text-terracota-escuro hover:bg-terracota/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <GiftPhotoSearchModal
        open={showPhotoSearchModal}
        giftTitle={title}
        currentImageUrl={imageUrl}
        currentPhotoSource={photoSource}
        previousImageUrl={initialPhotoBackup?.imageUrl || imageUrl}
        previousPhotoSource={initialPhotoBackup?.photoSource}
        onApplyPhoto={applyPhotoPayload}
        onRestorePrevious={handleRestorePreviousPhoto}
        onClose={() => setShowPhotoSearchModal(false)}
      />

      <LegacyGalleryCleanupModal
        open={showLegacyCleanupModal}
        gifts={gifts}
        onClose={() => setShowLegacyCleanupModal(false)}
      />

      {orderToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-order-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-marrom/55 p-4 backdrop-blur-xs"
          onClick={() => {
            if (!deletingOrder) {
              setOrderToDelete(null);
              setOrderDeleteError(null);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-dourado/45 bg-creme-claro p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-terracota/35 bg-terracota/10 text-terracota-escuro">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3
                  id="confirm-delete-order-title"
                  className="font-display text-2xl font-semibold text-marrom"
                >
                  Excluir este registro?
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-marrom-suave">
                  Esta ação removerá o registro do histórico administrativo e não poderá ser desfeita.
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-dourado/30 bg-creme/70 px-3.5 py-2.5 text-xs text-marrom">
              <p className="font-semibold truncate">{orderToDelete.giverName}</p>
              <p className="mt-0.5 text-marrom-suave truncate">
                {orderToDelete.giftTitle} ·{' '}
                <strong className="text-terracota-escuro tabular-nums">
                  {formatBRL(orderToDelete.amountCents)}
                </strong>
              </p>
            </div>

            {(orderToDelete.status === 'confirmed' ||
              Boolean(orderToDelete.confirmedAtIso) ||
              orderToDelete.paymentMethod === 'pix_webhook') && (
              <p className="mt-3 rounded-md border border-dourado/40 bg-creme px-3 py-2 text-xs text-marrom-suave">
                Registros com pagamento confirmado são arquivados (ocultados do histórico ativo) para preservar comprovantes e a prestação de contas financeira.
              </p>
            )}

            {orderDeleteError && (
              <p
                role="alert"
                className="mt-3 rounded-md border border-terracota/40 bg-terracota/10 px-3 py-2 text-xs text-terracota-escuro"
              >
                {orderDeleteError}
              </p>
            )}

            <div className="mt-6 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                disabled={deletingOrder}
                onClick={() => {
                  setOrderToDelete(null);
                  setOrderDeleteError(null);
                }}
                className="rounded-md border border-dourado/45 bg-creme px-4 py-2 text-xs font-semibold text-marrom uppercase hover:bg-pergaminho disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletingOrder}
                onClick={handleConfirmDeleteOrder}
                className="inline-flex items-center gap-1.5 rounded-md bg-terracota-escuro px-4 py-2 text-xs font-semibold text-creme-claro uppercase hover:bg-terracota disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deletingOrder ? 'Excluindo...' : 'Sim, excluir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
