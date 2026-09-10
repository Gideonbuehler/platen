import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * A vertical gradient scrim, built from stacked translucent bands.
 *
 * Deliberately not expo-linear-gradient. That is a native module, and adding
 * one means every developer and every installed build needs a native rebuild
 * before the app will even open the screen that uses it — a steep price for
 * darkening the area behind some icons. Alpha compositing over enough bands is
 * visually indistinguishable at these opacities and is pure JS, so it works
 * the moment the bundle reloads.
 */
export function Scrim({
  from,
  opacity = 0.7,
  bands = 10,
}: {
  /** Which edge is darkest. */
  from: 'top' | 'bottom';
  /** Alpha at the darkest edge. */
  opacity?: number;
  bands?: number;
}) {
  const layers = useMemo(() => {
    const flex = 1 / bands;
    return Array.from({ length: bands }, (_, i) => {
      // Squared falloff rather than linear: a straight ramp leaves a visible
      // edge where the scrim ends, while an eased one fades into the photo.
      const progress = (bands - 1 - i) / (bands - 1);
      return { key: i, flex, alpha: opacity * progress * progress };
    });
  }, [bands, opacity]);

  return (
    <View
      style={[StyleSheet.absoluteFill, { flexDirection: from === 'top' ? 'column' : 'column-reverse' }]}
      pointerEvents="none"
    >
      {layers.map((layer) => (
        <View
          key={layer.key}
          style={{ flex: layer.flex, backgroundColor: `rgba(0,0,0,${layer.alpha.toFixed(3)})` }}
        />
      ))}
    </View>
  );
}
