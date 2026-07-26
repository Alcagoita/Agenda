/**
 * AppNavigator — root stack navigator shown after login.
 *
 * Structure:
 *   NativeStack
 *     ├── Today    — always the root screen
 *     ├── Calendar — pushed by tapping the day number in TodayScreen (KAN-50)
 *     └── Profile  — pushed from the avatar in the Header
 *
 * No tab bar — navigation follows the design spec (avatar → profile).
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import TodayScreen from '../screens/TodayScreen';
import CalendarScreen from '../screens/CalendarScreen';
import ProfileScreen from '../screens/ProfileScreen';
import CategoriesScreen from '../screens/CategoriesScreen';
import TaskFormScreen, { TaskFormParams } from '../screens/TaskFormScreen';
import PointsHistoryScreen from '../screens/PointsHistoryScreen';
import PublicProfileScreen from '../screens/PublicProfileScreen';
import SharedTaskInboxScreen from '../screens/SharedTaskInboxScreen';
import SocialHubScreen from '../screens/SocialHubScreen';
import ShareToDoScreen from '../screens/ShareToDoScreen';
import CreateChallengeScreen from '../screens/CreateChallengeScreen';
import ChallengeDetailScreen from '../screens/ChallengeDetailScreen';
import ContactSuggestionsScreen from '../screens/ContactSuggestionsScreen';
import CompareAchievementsScreen from '../screens/CompareAchievementsScreen';
import ShareReceiveScreen from '../screens/ShareReceiveScreen';
import SettingsScreen from '../screens/SettingsScreen';
import NotificationPreferencesScreen from '../screens/NotificationPreferencesScreen';
import AchievementsScreen from '../screens/AchievementsScreen';
import TripPlannerScreen from '../screens/TripPlannerScreen';
import OffGridScreen from '../screens/OffGridScreen';
import PlacesIKnowScreen from '../screens/PlacesIKnowScreen';
import HomeAddressScreen from '../screens/HomeAddressScreen';
import WhereWeveBeenScreen from '../screens/WhereWeveBeenScreen';
import ItineraryOptionsScreen from '../screens/ItineraryOptionsScreen';
import PlacesScreen from '../screens/PlacesScreen';

export type RootStackParamList = {
  Today: undefined;
  /** Optional initial date (YYYY-MM-DD); defaults to today if omitted. */
  Calendar: { initialDate?: string } | undefined;
  Profile: undefined;
  Categories: undefined;
  /** Full task creation / edit form (KAN-12 / KAN-13). Presented as a modal. */
  TaskForm: TaskFormParams;
  /** Points history + achievements gallery (KAN-33). Pushed from ProfileScreen. */
  PointsHistory: undefined;
  /** Public profile card opened via brushaway.app/u/{username} deep link (KAN-97). */
  PublicProfile: { username: string };
  /** Shared-task inbox — receive, accept and decline (KAN-87). */
  SharedTaskInbox: undefined;
  /** Friends & Social hub — activity feed + following list (KAN-100). */
  SocialHub: undefined;
  /** Task picker + friend picker for sharing a to-do (KAN-101). */
  ShareToDo: { taskId?: string } | undefined;
  /** Challenge creation flow — type, params, friends, message (KAN-102). */
  CreateChallenge: undefined;
  /** Live challenge detail with leaderboard (KAN-103). */
  ChallengeDetail: { challengeId: string };
  /** Phone contacts friend suggestions (KAN-99). */
  ContactSuggestions: undefined;
  /** Side-by-side achievement and stats comparison with a friend (KAN-105). */
  CompareAchievements: { friendUid: string; friendUsername: string };
  /** Android Share Intent receiver — confirmation / failure form (KAN-90). */
  ShareReceive: { sharedText: string };
  /** App & account settings (KAN-113). */
  Settings: undefined;
  /** Notification toggles and scheduling (KAN-80). */
  NotificationPreferences: undefined;
  /** Full achievements list with progress and point values (KAN-114 / KAN-129 / KAN-122). */
  Achievements: { achievementId?: string } | undefined;
  /** Trip Planner — "Going somewhere?" offline area download flow (KAN-234). Optional prefillStartDate (YYYY-MM-DD) when opened from a future Calendar day (KAN-243). Optional prefillDestinationQuery — free-text search-box seed from the calendar trip-suggestion signal (KAN-245), never a resolved place (that signal never geocodes). KAN-266 edit mode reuses the same dates/radius steps for an existing trip. */
  TripPlanner: {
    prefillStartDate?: string;
    prefillDestinationQuery?: string;
    editTripId?: string;
    initialStep?: 'dates' | 'radius';
  } | undefined;
  /** "Places I know" — the always-on habitat area + downloaded trips, with refresh/delete (KAN-234). */
  PlacesIKnow: undefined;
  /** Places — brands + trips + past trips, behind the Lantern pill (KAN-304). */
  Places: undefined;
  /** Explicit home address — set/edit/clear (KAN-247). */
  HomeAddress: undefined;
  /** Off-grid window — "I'll be offline for a while, keep my tasks going" (KAN-246). Now + duration, never dated like TripPlanner. */
  OffGrid: undefined;
  /** "Where we've been" — past-trip timeline, destination + dates only (KAN-257). Optional highlightTripId when opened from a past day's Calendar row, to draw the eye to that trip. */
  WhereWeveBeen: { highlightTripId?: string } | undefined;
  /** "One trip for all of these" — resolves + orders open POI tasks into a
   *  multi-stop route into a single suggestion card (KAN-281). */
  ItineraryOptions: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function AppNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Today"      component={TodayScreen} />
      <Stack.Screen name="Calendar"   component={CalendarScreen} />
      <Stack.Screen name="Profile"    component={ProfileScreen} />
      <Stack.Screen name="Categories" component={CategoriesScreen} />
      <Stack.Screen
        name="TaskForm"
        component={TaskFormScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen name="PointsHistory"    component={PointsHistoryScreen} />
      <Stack.Screen name="PublicProfile"   component={PublicProfileScreen} />
      <Stack.Screen name="SharedTaskInbox" component={SharedTaskInboxScreen} />
      <Stack.Screen name="SocialHub"  component={SocialHubScreen} />
      <Stack.Screen name="ShareToDo"        component={ShareToDoScreen} />
      <Stack.Screen name="CreateChallenge" component={CreateChallengeScreen} />
      <Stack.Screen name="ChallengeDetail"     component={ChallengeDetailScreen} />
      <Stack.Screen name="ContactSuggestions"   component={ContactSuggestionsScreen} />
      <Stack.Screen name="CompareAchievements"  component={CompareAchievementsScreen} />
      <Stack.Screen
        name="ShareReceive"
        component={ShareReceiveScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen name="Settings"                   component={SettingsScreen} />
      <Stack.Screen name="NotificationPreferences"    component={NotificationPreferencesScreen} />
      <Stack.Screen name="Achievements"               component={AchievementsScreen} />
      <Stack.Screen name="TripPlanner"                component={TripPlannerScreen} />
      <Stack.Screen name="OffGrid"                    component={OffGridScreen} />
      <Stack.Screen name="PlacesIKnow"                component={PlacesIKnowScreen} />
      <Stack.Screen name="Places"                     component={PlacesScreen} />
      <Stack.Screen name="HomeAddress"                component={HomeAddressScreen} />
      <Stack.Screen name="WhereWeveBeen"              component={WhereWeveBeenScreen} />
      <Stack.Screen name="ItineraryOptions"           component={ItineraryOptionsScreen} />
    </Stack.Navigator>
  );
}
