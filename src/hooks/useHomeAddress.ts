/**
 * useHomeAddress — KAN-247.
 *
 * State/logic for Settings' "Home" flow: address search (debounced, mirrors
 * useTripPlanner's destination step) → resolve → save. No JSX —
 * independently testable, matching the rest of this codebase's screen/hook
 * split.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { searchAddressAutocomplete } from '../services/maps';
import type { PlaceAutocompleteSuggestion } from '../services/maps';
import { getUser, setHome, clearHome } from '../services/firestore';
import { setHomeLocation } from '../services/home';
import type { HomeLocation } from '../services/home';
import { COPY } from '../constants/copy';

const AUTOCOMPLETE_DEBOUNCE_MS = 300;

export interface HomeAddressState {
  loading: boolean;
  home: HomeLocation | null;
  query: string;
  setQuery: (q: string) => void;
  suggestions: PlaceAutocompleteSuggestion[];
  /** Resolves true on a successful save — callers should only leave search mode then, so saving/error stay visible on failure. */
  selectSuggestion: (s: PlaceAutocompleteSuggestion) => Promise<boolean>;
  saving: boolean;
  error: string | null;
  clear: () => Promise<void>;
}

export function useHomeAddress(): HomeAddressState {
  const uid = getAuth().currentUser?.uid ?? '';

  const [loading, setLoading]         = useState(true);
  const [home, setHomeState]          = useState<HomeLocation | null>(null);
  const [query, setQuery]             = useState('');
  const [suggestions, setSuggestions] = useState<PlaceAutocompleteSuggestion[]>([]);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const justSelectedRef = useRef(false);

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    getUser(uid)
      .then(u => setHomeState(u?.home ?? null))
      .catch(err => console.warn('[useHomeAddress] getUser failed', err))
      .finally(() => setLoading(false));
  }, [uid]);

  // Debounced address autocomplete — same shape as useTripPlanner's.
  useEffect(() => {
    if (justSelectedRef.current) { justSelectedRef.current = false; return; }
    if (!query.trim()) { setSuggestions([]); return; }

    const timer = setTimeout(() => {
      searchAddressAutocomplete(query)
        .then(setSuggestions)
        .catch(err => console.warn('[useHomeAddress] searchAddressAutocomplete failed', err));
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const selectSuggestion = useCallback(async (suggestion: PlaceAutocompleteSuggestion) => {
    justSelectedRef.current = true;
    setQuery(suggestion.name);
    setSuggestions([]);
    if (!uid) { return false; }

    setSaving(true);
    setError(null);
    try {
      if (suggestion.lat == null || suggestion.lng == null) {
        setError(COPY.home.saveErrorToast);
        return false;
      }
      const address = [suggestion.name, suggestion.address].filter(Boolean).join(', ');
      const next: HomeLocation = { address, lat: suggestion.lat, lng: suggestion.lng };
      await setHome(uid, next);
      setHomeState(next);
      setHomeLocation(next);
      return true;
    } catch (err) {
      console.warn('[useHomeAddress] save failed', err);
      setError(COPY.home.saveErrorToast);
      return false;
    } finally {
      setSaving(false);
    }
  }, [uid]);

  const clear = useCallback(async () => {
    if (!uid) { return; }
    setSaving(true);
    setError(null);
    try {
      await clearHome(uid);
      setHomeState(null);
      setHomeLocation(null);
      setQuery('');
    } catch (err) {
      console.warn('[useHomeAddress] clear failed', err);
      setError(COPY.home.clearErrorToast);
    } finally {
      setSaving(false);
    }
  }, [uid]);

  return { loading, home, query, setQuery, suggestions, selectSuggestion, saving, error, clear };
}
