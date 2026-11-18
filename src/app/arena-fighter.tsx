import { Redirect } from 'expo-router';
import { Platform } from 'react-native';

import ArenaFighterScreen from '@/features/arena-fighter/arena-fighter-screen';
import { isQuestDevice } from '@/features/quest-vr/quest-platform';

// Phone AR must not mount on a Quest, including through invitation deep links.
export default function ArenaFighterRoute() {
  return isQuestDevice(Platform) ? <Redirect href="/quest-vr" /> : <ArenaFighterScreen />;
}
