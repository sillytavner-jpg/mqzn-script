<template>
  <div class="zn-empty">
    <slot name="icon">
      <svg class="zn-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4L12 17l-6.3 4.4L8 14 2 9.4h7.6z" />
      </svg>
    </slot>
    <p class="zn-empty-text">{{ text }}</p>
    <button v-if="actionText" class="zn-empty-action" @click="$emit('action')">{{ actionText }}</button>
    <slot name="extra" />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'EmptyHint' });
defineProps<{ text: string; actionText?: string }>();
defineEmits<{ (e: 'action'): void }>();
</script>

<style scoped>
.zn-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--zn-space-2);
  padding: var(--zn-space-6) var(--zn-space-4);
  text-align: center;
}
.zn-empty-icon {
  color: var(--zn-text-muted);
  opacity: 0.5;
  filter: drop-shadow(0 0 8px var(--zn-accent-glow));
}
.zn-empty-text {
  font-size: var(--zn-fs-body);
  color: var(--zn-text-muted);
  line-height: 1.6;
  max-width: 28em;
}
.zn-empty-action {
  margin-top: var(--zn-space-1);
  padding: var(--zn-space-1) var(--zn-space-4);
  font-size: var(--zn-fs-body);
  color: var(--zn-accent);
  background: var(--zn-accent-dim);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.3);
  border-radius: var(--zn-radius-pill);
  cursor: pointer;
  transition: all var(--zn-dur) var(--zn-ease);
}
.zn-empty-action:hover {
  background: rgba(var(--zn-accent-rgb), 0.22);
  box-shadow: var(--zn-glow-accent);
}
</style>
