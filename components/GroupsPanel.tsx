import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { SEARCH_DELAY_MS, searchQuery } from "@/lib/search";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import Field from "@/components/Field";
import {
  answerInvite,
  cancelInvite,
  createGroup,
  deleteGroup,
  inviteToGroup,
  removeMember,
  renameGroup,
  searchUsers,
  type DeviceAuth,
  type FoundUser,
  type Group,
  type Invite,
} from "@/lib/api";

type Props = {
  auth: DeviceAuth;
  userId: number;
  groups: Group[];
  invites: Invite[];
  avatarFor: (url?: string | null) => string | null;
  // Reload groups and invites after a change.
  onChanged: () => void;
  // Pictures of found people, so the parent can load them.
  onAvatarUrls: (urls: string[]) => void;
};

// Runs a request, shows the server's message when it fails and reloads when it worked.
function useAction(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged();
      return true;
    } catch (e: any) {
      setError(e?.message || "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function confirm(title: string, message: string, action: string, onConfirm: () => void) {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);
}

export default function GroupsPanel({ auth, userId, groups, invites, avatarFor, onChanged, onAvatarUrls }: Props) {
  const { colors: c } = useThemeManager();
  const [name, setName] = useState("");
  const create = useAction(onChanged);
  const answer = useAction(onChanged);

  const submitCreate = async () => {
    const value = name.trim();
    if (!value) return;
    if (await create.run(() => createGroup(auth, value))) setName("");
  };

  return (
    <View>
      {invites.length > 0 && (
        <>
          <Text style={[styles.section, { color: c.muted }]}>Invitations</Text>
          {invites.map((invite) => (
            <View key={invite.id} style={[styles.card, { backgroundColor: c.subtle }]}>
              <Text style={[styles.cardTitle, { color: c.primary }]}>{invite.groupName}</Text>
              <Text style={[styles.meta, { color: c.muted }]}>Invited by {invite.invitedBy.displayName}</Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.button, { backgroundColor: c.secondary }]}
                  disabled={answer.busy}
                  onPress={() => answer.run(() => answerInvite(auth, invite.id, true))}
                >
                  <Text style={[styles.buttonText, { color: c.onSecondary }]}>Accept</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, { backgroundColor: c.raised }]}
                  disabled={answer.busy}
                  onPress={() => answer.run(() => answerInvite(auth, invite.id, false))}
                >
                  <Text style={[styles.buttonText, { color: c.primary }]}>Decline</Text>
                </Pressable>
              </View>
            </View>
          ))}
          {answer.error ? <Text style={[styles.error, { color: c.secondary }]}>{answer.error}</Text> : null}
        </>
      )}

      <Text style={[styles.section, { color: c.muted }]}>My groups</Text>
      {groups.length === 0 && <Text style={[styles.meta, { color: c.muted }]}>You are not in a group yet.</Text>}
      {groups.map((group) => (
        <GroupCard key={group.id} auth={auth} userId={userId} group={group} avatarFor={avatarFor} onChanged={onChanged} onAvatarUrls={onAvatarUrls} />
      ))}

      <Text style={[styles.section, { color: c.muted }]}>Create group</Text>
      <Field
        label="Group name"
        icon="group-add"
        value={name}
        onChangeText={setName}
        autoCapitalize="sentences"
        maxLength={48}
        returnKeyType="done"
        onSubmitEditing={submitCreate}
      />
      {create.error ? <Text style={[styles.error, { color: c.secondary }]}>{create.error}</Text> : null}
      <Pressable
        style={[styles.wide, { backgroundColor: c.secondary, opacity: create.busy || !name.trim() ? 0.6 : 1 }]}
        disabled={create.busy || !name.trim()}
        onPress={submitCreate}
      >
        {create.busy ? <ActivityIndicator color={c.onSecondary} /> : <Text style={[styles.buttonText, { color: c.onSecondary }]}>Create</Text>}
      </Pressable>
    </View>
  );
}

function GroupCard({
  auth,
  userId,
  group,
  avatarFor,
  onChanged,
  onAvatarUrls,
}: {
  auth: DeviceAuth;
  userId: number;
  group: Group;
  avatarFor: (url?: string | null) => string | null;
  onChanged: () => void;
  onAvatarUrls: (urls: string[]) => void;
}) {
  const { colors: c } = useThemeManager();
  const { busy, error, run } = useAction(onChanged);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(group.name);
  const [username, setUsername] = useState("");
  const isOwner = group.role === "owner";

  const saveName = async () => {
    const value = title.trim();
    if (!value || value === group.name) {
      setRenaming(false);
      return;
    }
    if (await run(() => renameGroup(auth, group.id, value))) setRenaming(false);
  };

  const [found, setFound] = useState<FoundUser[]>([]);
  const [focused, setFocused] = useState(false);
  const searchRun = useRef(0);

  // Suggestions while typing: debounced, and an answer that arrives late is ignored.
  useEffect(() => {
    const query = searchQuery(username);
    const current = ++searchRun.current;
    if (!query) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      searchUsers(auth, query, group.id)
        .then((list) => {
          if (current !== searchRun.current) return;
          setFound(list);
          onAvatarUrls(list.map((u) => u.avatarUrl).filter((u): u is string => !!u));
        })
        .catch(() => current === searchRun.current && setFound([]));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [username, auth, group.id, onAvatarUrls]);

  const invite = async (name?: string) => {
    const value = (name ?? username).trim();
    if (!value) return;
    setFound([]);
    if (await run(() => inviteToGroup(auth, group.id, value))) setUsername("");
  };

  return (
    <View style={[styles.card, { backgroundColor: c.subtle }]}>
      <View style={styles.row}>
        <Text style={[styles.cardTitle, { color: c.primary, flex: 1 }]} numberOfLines={1}>
          {group.name}
        </Text>
        <View style={[styles.tag, { backgroundColor: c.raised }]}>
          <Text style={[styles.tagText, { color: c.muted }]}>{isOwner ? "Owner" : "Member"}</Text>
        </View>
        {group.canManage && (
          <>
            <Pressable onPress={() => setRenaming((open) => !open)} hitSlop={8} accessibilityLabel="Rename the group">
              <MaterialIcons name="edit" size={20} color={c.muted} />
            </Pressable>
            <Pressable
              onPress={() =>
                confirm("Delete group", `Delete "${group.name}"? Its members stop seeing each other through it.`, "Delete", () =>
                  run(() => deleteGroup(auth, group.id))
                )
              }
              hitSlop={8}
              accessibilityLabel="Delete the group"
            >
              <MaterialIcons name="delete-outline" size={21} color={c.secondary} />
            </Pressable>
          </>
        )}
      </View>

      {renaming && (
        <View style={styles.inline}>
          <View style={{ flex: 1 }}>
            <Field label="Name" icon="edit" value={title} onChangeText={setTitle} autoCapitalize="sentences" maxLength={48} />
          </View>
          <Pressable style={[styles.smallButton, { backgroundColor: c.secondary }]} onPress={saveName} disabled={busy}>
            <Text style={[styles.buttonText, { color: c.onSecondary }]}>Save</Text>
          </Pressable>
        </View>
      )}

      {group.members.map((member) => {
        const self = member.id === userId;
        const removable = group.canManage && member.id !== group.ownerId && !self;
        return (
          <View key={member.id} style={styles.member}>
            <Avatar name={member.displayName} uri={avatarFor(member.avatarUrl)} state="offline" size={30} gapColor={c.subtle} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.memberName, { color: c.primary }]} numberOfLines={1}>
                {member.displayName}
                {self ? <Text style={{ color: c.muted, fontWeight: "500" }}>  · You</Text> : null}
              </Text>
              <Text style={[styles.meta, { color: c.muted }]}>@{member.username}</Text>
            </View>
            {member.role === "owner" && (
              <View style={[styles.tag, { backgroundColor: c.raised }]}>
                <Text style={[styles.tagText, { color: c.muted }]}>Owner</Text>
              </View>
            )}
            {removable && (
              <Pressable
                onPress={() =>
                  confirm("Remove member", `Remove ${member.displayName} from "${group.name}"?`, "Remove", () =>
                    run(() => removeMember(auth, group.id, member.id))
                  )
                }
                hitSlop={8}
                accessibilityLabel={`Remove ${member.displayName}`}
              >
                <MaterialIcons name="person-remove" size={20} color={c.secondary} />
              </Pressable>
            )}
          </View>
        );
      })}

      {group.canManage && (group.pendingInvites ?? []).length > 0 && (
        <>
          <Text style={[styles.subSection, { color: c.muted }]}>Invited</Text>
          {(group.pendingInvites ?? []).map((pending) => (
            <View key={pending.id} style={styles.member}>
              <MaterialIcons name="schedule" size={22} color={c.muted} />
              <Text style={[styles.memberName, { color: c.primary, flex: 1 }]} numberOfLines={1}>
                {pending.user.displayName} <Text style={{ color: c.muted, fontWeight: "500" }}>@{pending.user.username}</Text>
              </Text>
              <Pressable
                onPress={() => run(() => cancelInvite(auth, group.id, pending.id))}
                hitSlop={8}
                accessibilityLabel={`Cancel the invitation for ${pending.user.displayName}`}
              >
                <MaterialIcons name="close" size={20} color={c.muted} />
              </Pressable>
            </View>
          ))}
        </>
      )}

      {group.canManage && (
        <View style={styles.inline}>
          <View style={{ flex: 1 }}>
            <Field
              label="Invite by username"
              icon="person-add-alt"
              value={username}
              onChangeText={setUsername}
              returnKeyType="send"
              onSubmitEditing={() => invite()}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 200)}
            />
          </View>
          <Pressable
            style={[styles.smallButton, { backgroundColor: c.secondary, opacity: busy || !username.trim() ? 0.6 : 1 }]}
            onPress={() => invite()}
            disabled={busy || !username.trim()}
          >
            <Text style={[styles.buttonText, { color: c.onSecondary }]}>Invite</Text>
          </Pressable>
        </View>
      )}

      {group.canManage && focused && found.length > 0 && (
        <View style={[styles.suggestions, { backgroundColor: c.raised }]}>
          {found.map((user) => (
            <Pressable
              key={user.id}
              style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: c.subtle }]}
              onPress={() => invite(user.username)}
              accessibilityLabel={`Invite ${user.displayName}`}
            >
              <Avatar name={user.displayName} uri={avatarFor(user.avatarUrl)} state="offline" size={28} gapColor={c.raised} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.memberName, { color: c.primary }]} numberOfLines={1}>
                  {user.displayName}
                </Text>
                <Text style={[styles.meta, { color: c.muted, marginTop: 0 }]} numberOfLines={1}>
                  @{user.username}
                </Text>
              </View>
              <MaterialIcons name="person-add-alt" size={20} color={c.muted} />
            </Pressable>
          ))}
        </View>
      )}

      {!isOwner && (
        <Pressable
          style={[styles.wide, { backgroundColor: c.raised }]}
          disabled={busy}
          onPress={() =>
            confirm("Leave group", `Leave "${group.name}"?`, "Leave", () => run(() => removeMember(auth, group.id, userId)))
          }
        >
          <Text style={[styles.buttonText, { color: c.secondary }]}>Leave</Text>
        </Pressable>
      )}

      {error ? <Text style={[styles.error, { color: c.secondary }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  subSection: { fontSize: 12, fontWeight: "600", marginTop: 10, marginBottom: 2 },
  card: { borderRadius: 18, padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  meta: { fontSize: 12.5, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  inline: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 10 },
  member: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  memberName: { fontSize: 14.5, fontWeight: "600" },
  tag: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 11, fontWeight: "700" },
  button: { flex: 1, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  smallButton: { height: 52, paddingHorizontal: 16, borderRadius: 14, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  wide: { height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", marginTop: 10 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  error: { fontSize: 13, marginTop: 8 },
  suggestions: { borderRadius: 14, marginTop: -6, marginBottom: 6, paddingVertical: 4 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7, paddingHorizontal: 10 },
});
