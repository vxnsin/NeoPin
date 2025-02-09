import { Text, View } from "react-native";
import useThemeManager from '@/hooks/useThemeManager';

export default function Index() {
  const colors = useThemeManager(); 

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.colors.surface, 
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ color: colors.colors.primary }}>Edit app/index.tsx to edit this screen.</Text>
    </View>
  );
}
