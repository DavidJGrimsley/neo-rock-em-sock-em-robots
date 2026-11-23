import { Platform } from 'react-native';

import QuestVRScreen from '@/features/quest-vr/quest-vr-screen';
import { isQuestDevice } from '@/features/quest-vr/quest-platform';

import HomeScreen from '../features/home/home-screen';

export default function IndexRoute() {
  return isQuestDevice(Platform) ? <QuestVRScreen /> : <HomeScreen />;
}
