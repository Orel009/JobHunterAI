import { ProfileEditor } from './ProfileEditor';

/** Profile screen: CV uploads (added in the CV-update step) + the profile editor. */
export function ProfileScreen({ onChanged }: { onChanged: () => void }) {
  return <ProfileEditor onSaved={onChanged} />;
}
