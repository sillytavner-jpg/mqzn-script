<template>
  <Transition name="zn-modal">
    <div v-if="visible" class="zn-overlay" :class="{ 'is-mobile': isMobile }" @click.self="$emit('close')">
      <div class="zn-modal-card" :class="{ 'is-mobile': isMobile }" :style="maxWidth ? { maxWidth } : undefined">
        <div v-if="title || $slots.header" class="zn-modal-header">
          <slot name="header">
            <span class="zn-modal-title">{{ title }}</span>
          </slot>
          <button class="zn-modal-close" aria-label="关闭" @click="$emit('close')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="zn-modal-body"><slot />
        </div>
        <div v-if="$slots.footer" class="zn-modal-footer"><slot name="footer" /></div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineOptions({ name: 'Modal' });
withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  isMobile?: boolean;
  maxWidth?: string;
}>(), { isMobile: false });
defineEmits<{ (e: 'close'): void }>();
</script>

<style scoped>
.zn-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--zn-z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--zn-space-4);
  background: rgba(5, 4, 16, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.zn-overlay.is-mobile {
  align-items: flex-end;
  padding: 0;
}

.zn-modal-card {
  position: relative;
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--zn-card-bg);
  border: 1px solid var(--zn-glass-border);
  border-radius: var(--zn-radius-lg);
  box-shadow: var(--zn-shadow-glass), var(--zn-glass-highlight);
  overflow: hidden;
}
.zn-modal-card.is-mobile {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--zn-radius-lg) var(--zn-radius-lg) 0 0;
  border-bottom: none;
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.zn-modal-header {
  display: flex;
  align-items: center;
  gap: var(--zn-space-2);
  padding: var(--zn-space-3) var(--zn-space-4);
  border-bottom: 1px solid var(--zn-border-light);
  flex-shrink: 0;
}
.zn-modal-title {
  flex: 1;
  font-size: var(--zn-fs-title);
  font-weight: 600;
  color: var(--zn-text-primary);
}
.zn-modal-close {
  flex-shrink: 0;
  min-width: 32px;
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--zn-radius-sm);
  color: var(--zn-text-muted);
  cursor: pointer;
  transition: all var(--zn-dur) var(--zn-ease);
}
.zn-modal-close:hover {
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface2);
}

.zn-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--zn-space-4);
  color: var(--zn-text-regular);
}
.zn-modal-footer {
  padding: var(--zn-space-3) var(--zn-space-4);
  border-top: 1px solid var(--zn-border-light);
  display: flex;
  justify-content: flex-end;
  gap: var(--zn-space-2);
  flex-shrink: 0;
}

/* 过渡 */
.zn-modal-enter-active { transition: opacity 0.2s var(--zn-ease); }
.zn-modal-leave-active { transition: opacity 0.15s var(--zn-ease); }
.zn-modal-enter-from, .zn-modal-leave-to { opacity: 0; }
.zn-modal-enter-active .zn-modal-card { transition: transform 0.25s var(--zn-ease); }
.zn-modal-enter-from .zn-modal-card { transform: scale(0.96) translateY(8px); }
.zn-modal-enter-active.is-mobile .zn-modal-card { transition: transform 0.3s var(--zn-ease); }
.zn-modal-enter-from.is-mobile .zn-modal-card { transform: translateY(100%); }
</style>
