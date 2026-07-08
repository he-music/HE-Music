import { computed, unref, type Ref, type WritableComputedRef } from "vue";

/**
 * Helper to handle logic where a setting should be disabled and forced to a specific value
 * when a certain condition is met.
 *
 * @param condition - The condition to check. Can be a boolean, a Ref, or a getter function.
 * @param forcedValue - The value to force when the condition is true. Can be a value, a Ref, or a getter function.
 * @param originalValue - The original WritableComputedRef for the setting.
 * @param originalDisabled - Optional. The original disabled state (boolean, Ref, or getter).
 * @returns An object containing `disabled` and `value` properties to be spread into the setting item.
 */
export function forceDisplaySettingIf<T>(
  condition: boolean | Ref<boolean> | (() => boolean),
  forcedValue: T | Ref<T> | (() => T),
  originalValue: WritableComputedRef<T>,
  originalDisabled?: boolean | Ref<boolean> | (() => boolean),
) {
  const isConditionMet = computed(() => {
    if (typeof condition === "function") {
      return condition();
    }
    return unref(condition);
  });

  const disabled = computed(() => {
    if (isConditionMet.value) return true;
    if (originalDisabled === undefined) return false;
    if (typeof originalDisabled === "function") {
      return originalDisabled();
    }
    return unref(originalDisabled);
  });

  const value = computed({
    get: () => {
      if (isConditionMet.value) {
        if (typeof forcedValue === "function") {
          return (forcedValue as () => T)();
        }
        return unref(forcedValue);
      }
      return originalValue.value;
    },
    set: (v: T) => {
      // Even if disabled, some UI components might try to set value.
      // We should only update the original value if the condition is NOT met.
      if (!isConditionMet.value) {
        originalValue.value = v;
      }
    },
  });

  return {
    disabled,
    value,
  };
}

/**
 * Template tag function for multi-line descriptions.
 * Removes common indentation and converts newlines to HTML <br> tags.
 */
export function descMultiline(strings: TemplateStringsArray, ...values: any[]): string {
  // Combine strings and values
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += values[i];
    }
  }

  // Remove the first newline if it exists
  if (result.startsWith("\n")) {
    result = result.substring(1);
  }

  const lines = result.split("\n");

  // Find the common indentation (ignoring empty lines)
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const indent = line.search(/\S/);
      if (indent !== -1 && indent < minIndent) {
        minIndent = indent;
      }
    }
  }

  // Remove indentation and join with <br>
  if (minIndent !== Infinity) {
    result = lines
      .map((line) => (line.length >= minIndent ? line.substring(minIndent) : line))
      .join("<br />");
  } else {
    result = lines.join("<br />");
  }

  return result;
}
