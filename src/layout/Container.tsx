import React from 'react';

/**
 * The app's content column. Centres children within the `shell` max width and applies the
 * responsive page gutters from the spacing tokens (`gutter` / `gutter-sm` / `gutter-lg`).
 */
export const Container: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className = '',
  children,
  ...rest
}) => (
  <div
    className={`w-full mx-auto max-w-shell px-gutter sm:px-gutter-sm lg:px-gutter-lg ${className}`}
    {...rest}
  >
    {children}
  </div>
);
