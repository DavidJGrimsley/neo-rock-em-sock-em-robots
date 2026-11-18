import { router } from 'expo-router';
import { View } from 'react-native';

import { useAppTheme } from '@/theme/provider';
import { GameStatusPanel } from '@/ui/game-status-panel';

export default function QuestVRScreen() {
  const { activeColors: colors } = useAppTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        padding: 20,
        backgroundColor: colors.background,
      }}>
      <GameStatusPanel
        title="Quest only"
        message="The VR runtime opens in the native Meta Quest build."
        actions={[{ label: 'Home', onPress: () => router.dismissTo('/') }]}
        compact
        outlinedActions={['Home']}
      />
    </View>
  );
}
