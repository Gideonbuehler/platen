import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useSession } from '../../src/lib/session';

/**
 * Bottom tabs.
 *
 * Four destinations, matching the web sidebar's top level. Backup and Settings
 * deliberately sit behind the Library tab rather than taking a slot of their
 * own: they are things you configure once, not places you go.
 */
export default function TabsLayout() {
  const { palette } = useSession();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: palette.surfaceBase },
        headerTintColor: palette.textPrimary,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: palette.surfaceBase,
          borderTopColor: palette.borderSubtle,
        },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textTertiary,
        sceneStyle: { backgroundColor: palette.surfaceBase },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Photos',
          tabBarIcon: ({ color, size }) => <Ionicons name="images-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: ({ color, size }) => <Ionicons name="search-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="albums"
        options={{
          title: 'Albums',
          tabBarIcon: ({ color, size }) => <Ionicons name="albums-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
