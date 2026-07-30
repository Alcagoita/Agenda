/**
 * useMallSnapshotToggle — KAN-237
 *
 * Profile's "Learn this mall" toggle. Flipping it on: fetches a fresh GPS
 * fix, finds the shopping mall at that position, downloads its POIs (one
 * Places call), and feeds the result into proximity.ts so cache-first
 * proximity applies immediately — no app restart needed. Flipping off
 * deletes the snapshot (doc + cached rows).
 *
 * No JSX — independently testable, matching the rest of this codebase's
 * screen/hook split.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { getCurrentPosition } from '../services/geolocation';
import { getCategories } from '../services/firestore';
import { deleteTripAreaPlaces } from '../services/habitatCache';
import { setMallSnapshot as setProximityMallSnapshot } from '../services/proximity';
import {
  getMallSnapshot,
  downloadMallSnapshot,
  deleteMallSnapshotDoc,
  MALL_SNAPSHOT_CACHE_AREA_ID,
  NoMallFoundError,
} from '../services/mallSnapshots';
import { getAreaDownloadPoiTypes } from '../services/tripDownload';
import { useToastStore } from '../store/toastStore';
import { COPY } from '../constants/copy';

export interface MallSnapshotToggleState {
  enabled: boolean;
  loading: boolean;
  toggle: (value: boolean) => Promise<void>;
}

export function useMallSnapshotToggle(): MallSnapshotToggleState {
  const uid = getAuth().currentUser?.uid ?? '';

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!uid) { return; }
    getMallSnapshot(uid)
      .then(snapshot => { if (mountedRef.current) { setEnabled(snapshot != null); } })
      .catch(err => console.warn('[useMallSnapshotToggle] initial load failed', err));
  }, [uid]);

  const turnOn = useCallback(async () => {
    if (!uid) { return; }
    setLoading(true);
    try {
      const coords = await getCurrentPosition();
      const categories = await getCategories(uid);
      const customCategoryPoiTypes = categories.map(c => c.poi).filter((p): p is string => !!p);
      const poiTypes = getAreaDownloadPoiTypes(customCategoryPoiTypes);

      const snapshot = await downloadMallSnapshot(uid, { lat: coords.lat, lng: coords.lng }, poiTypes);
      setProximityMallSnapshot(snapshot);
      if (mountedRef.current) { setEnabled(true); }
    } catch (err) {
      console.warn('[useMallSnapshotToggle] turnOn failed', err);
      const message = err instanceof NoMallFoundError
        ? COPY.mallSnapshot.noMallFoundToast
        : COPY.mallSnapshot.errorToast;
      useToastStore.getState().showToast(message);
      if (mountedRef.current) { setEnabled(false); }
    } finally {
      if (mountedRef.current) { setLoading(false); }
    }
  }, [uid]);

  const turnOff = useCallback(async () => {
    if (!uid) { return; }
    setLoading(true);
    try {
      await deleteMallSnapshotDoc(uid);
      deleteTripAreaPlaces(MALL_SNAPSHOT_CACHE_AREA_ID);
      setProximityMallSnapshot(null);
      if (mountedRef.current) { setEnabled(false); }
    } catch (err) {
      console.warn('[useMallSnapshotToggle] turnOff failed', err);
      useToastStore.getState().showToast(COPY.mallSnapshot.errorToast);
    } finally {
      if (mountedRef.current) { setLoading(false); }
    }
  }, [uid]);

  const toggle = useCallback((value: boolean) => (value ? turnOn() : turnOff()), [turnOn, turnOff]);

  return { enabled, loading, toggle };
}
