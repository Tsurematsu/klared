import React from 'react';
import { Text, useInput } from 'ink';
import { maskTokenForDisplay } from '../utils/validation.js';

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  placeholder?: string;
  mask?: boolean;
}

export const TextInput: React.FC<TextInputProps> = ({
  value,
  onChange,
  onSubmit,
  focus = true,
  placeholder = '',
  mask = false,
}) => {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }

      if (key.ctrl && input === 'u') {
        onChange('');
        return;
      }

      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }

      if (
        key.ctrl ||
        key.meta ||
        key.escape ||
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow
      ) {
        return;
      }

      if (input) {
        const sanitized = input.replace(/[\r\n]/g, '');
        if (sanitized) {
          onChange(value + sanitized);
        }
      }
    },
    { isActive: focus },
  );

  if (!value && !focus) {
    return <Text dimColor>{placeholder || ' '}</Text>;
  }

  if (!value && focus) {
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  const displayed = mask ? maskTokenForDisplay(value, 40) : value;

  return (
    <Text>
      {displayed}
      {focus ? <Text inverse> </Text> : null}
    </Text>
  );
};
