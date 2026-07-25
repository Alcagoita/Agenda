/**
 * Brush Cloud Functions — entry point
 *
 * All exported functions are picked up by the Firebase CLI on deployment.
 */

import { initializeApp, getApps } from 'firebase-admin/app';

// Guarded so re-imports (e.g. during tests or hot reload) don't throw
// "app already exists".
if (getApps().length === 0) {
  initializeApp();
}

export { onUserInactive } from './onUserInactive';
export { onUserLapsed } from './onUserLapsed';
export { onFriendActivity } from './onFriendActivity';
export { rolloverIncompleteTasks } from './rolloverIncompleteTasks';
export { sweepPoiInferenceMisses } from './sweepPoiInferenceMisses';
export { onFollowRequest } from './onFollowRequest';
export { onSharedTaskCreated } from './onSharedTaskCreated';
export { onChallengeNotifications } from './onChallengeNotifications';
export {
  processTaskCompletionRewards,
  awardOnboardingBonus,
  onTaskCreatedRewards,
  onCategoryCreatedRewards,
} from './rewards';
export {
  searchNearbyPlacesProxy,
  placesAutocompleteProxy,
  getPlaceDetailsProxy,
} from './places';
