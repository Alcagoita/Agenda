/**
 * TripsTab — the "Trips" tab body (KAN-304): planned trips ("Where you're
 * going", nearest flagged Next up), a separation band, then past trips by year
 * ("Where you've been"). Owns its own trip navigation and the forget-confirm
 * dialog; PlacesScreen only hands it data + the raw forget action.
 */
import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SuitcaseIcon, PinIcon } from '../components/AppIcon';
import { sectionTitleStyle } from '../theme/tokens';
import SectionHeader from '../components/places/SectionHeader';
import AddButton from '../components/places/AddButton';
import EmptyPanel from '../components/places/EmptyPanel';
import TripCard from '../components/places/TripCard';
import PastTripRow from '../components/places/PastTripRow';
import type { Palette } from '../components/places/shared';
import { nextUpTripId } from '../services/places';
import type { TripYearGroup } from '../hooks/useWhereWeveBeen';
import type { RootStackParamList } from '../navigation/AppNavigator';
import type { Trip } from '../types';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Places'>;

export default function TripsTab({ palette, activeTrips, pastTripGroups, onForget }: {
  palette: Palette;
  activeTrips: Trip[];
  pastTripGroups: TripYearGroup[];
  onForget: (trip: Trip) => void;
}) {
  const navigation = useNavigation<Nav>();
  const nextUpId = nextUpTripId(activeTrips);

  const addTrip = () => navigation.navigate('TripPlanner', { doneReturnTo: 'Places' });
  const editDates = (trip: Trip) =>
    navigation.navigate('TripPlanner', { editTripId: trip.id, initialStep: 'dates', doneReturnTo: 'Places' });
  const editArea = (trip: Trip) =>
    navigation.navigate('TripPlanner', { editTripId: trip.id, initialStep: 'radius', doneReturnTo: 'Places' });

  const confirmForget = (trip: Trip) => {
    Alert.alert(COPY.places.forgetTripTitle(trip.destination), COPY.places.forgetTripBody, [
      { text: COPY.places.forgetTripCancel, style: 'cancel' },
      { text: COPY.places.forgetTripConfirm, style: 'destructive', onPress: () => onForget(trip) },
    ]);
  };

  return (
    <>
      {/* Planned trips */}
      <SectionHeader label={COPY.places.sectionWhereGoing} palette={palette} />
      <Text style={[styles.subLine, { color: palette.faint }]}>{COPY.places.whereGoingSub}</Text>
      {activeTrips.length === 0 ? (
        <EmptyPanel
          icon={SuitcaseIcon}
          line={COPY.places.emptyPlanned}
          palette={palette}
          action={{ label: COPY.places.tripsAddAction, onPress: addTrip }}
        />
      ) : (
        <>
          {activeTrips.map(trip => (
            <TripCard
              key={trip.id}
              trip={trip}
              nextUp={trip.id === nextUpId}
              palette={palette}
              onEditDates={() => editDates(trip)}
              onEditArea={() => editArea(trip)}
              onRemove={() => confirmForget(trip)}
            />
          ))}
          {/* Add button AFTER the bounded list of planned trips. */}
          <View style={styles.tripsAddWrap}>
            <AddButton label={COPY.places.tripsAddAction} onPress={addTrip} palette={palette} />
          </View>
        </>
      )}

      {/* Double the gap before the second section. */}
      <SectionHeader label={COPY.places.sectionWhereBeen} palette={palette} style={styles.secondSection} />
      {pastTripGroups.length === 0 ? (
        <EmptyPanel icon={PinIcon} line={COPY.places.emptyPastTrips} palette={palette} />
      ) : (
        pastTripGroups.map(group => (
          <View key={group.year}>
            <Text style={[styles.yearLabel, { color: palette.faint }]}>{group.year}</Text>
            {group.trips.map(trip => (
              <PastTripRow key={trip.id} trip={trip} palette={palette} onRemove={() => confirmForget(trip)} />
            ))}
          </View>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  subLine: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 10, fontVariant: ['tabular-nums'] },
  yearLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 10, fontVariant: ['tabular-nums'] },
  tripsAddWrap: { marginTop: 10 },
  secondSection: { marginTop: (sectionTitleStyle.marginTop as number) * 2 },
});
