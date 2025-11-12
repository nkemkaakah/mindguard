import { useTooltip } from "@/providers/TooltipProvider";
import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type TooltipProps = {
  children: React.ReactNode;
  className?: string;
  content: string;
  id?: number | string;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
};

export const Tooltip = ({ 
  children, 
  className, 
  content, 
  id,
  side = "top",
  sideOffset = 8
}: TooltipProps) => {
  const { activeTooltip, showTooltip, hideTooltip } = useTooltip();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [isHoverAvailable, setIsHoverAvailable] = useState(false);
  const [isPointer, setIsPointer] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setIsHoverAvailable(window.matchMedia("(hover: hover)").matches);
  }, []);

  const tooltipIdentifier = id ? id + content : content;
  const tooltipId = `tooltip-${id || content.replace(/\s+/g, "-")}`;
  const isVisible = activeTooltip === tooltipIdentifier;

  // Calculate tooltip position based on trigger element
  useLayoutEffect(() => {
    if (!isVisible || !triggerRef.current) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      if (!triggerRef.current) return;

      const triggerRect = triggerRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const padding = 8;

      // Get actual tooltip dimensions if available, otherwise estimate
      const tooltipWidth = tooltipRef.current?.getBoundingClientRect().width || 200;
      const tooltipHeight = tooltipRef.current?.getBoundingClientRect().height || 32;

      let top = 0;
      let left = 0;
      let preferredSide = side;

      // Calculate preferred position
      if (preferredSide === "top") {
        top = triggerRect.top + scrollY - tooltipHeight - sideOffset;
        left = triggerRect.left + scrollX + triggerRect.width / 2 - tooltipWidth / 2;
      } else if (preferredSide === "bottom") {
        top = triggerRect.bottom + scrollY + sideOffset;
        left = triggerRect.left + scrollX + triggerRect.width / 2 - tooltipWidth / 2;
      } else if (preferredSide === "left") {
        top = triggerRect.top + scrollY + triggerRect.height / 2 - tooltipHeight / 2;
        left = triggerRect.left + scrollX - tooltipWidth - sideOffset;
      } else {
        top = triggerRect.top + scrollY + triggerRect.height / 2 - tooltipHeight / 2;
        left = triggerRect.right + scrollX + sideOffset;
      }

      // Check horizontal boundaries
      if (left < padding) {
        left = padding;
      } else if (left + tooltipWidth > viewportWidth - padding) {
        left = viewportWidth - tooltipWidth - padding;
      }

      // Check vertical boundaries and flip if needed
      if (preferredSide === "top" && top < scrollY + padding) {
        // Not enough space on top, flip to bottom
        top = triggerRect.bottom + scrollY + sideOffset;
      } else if (preferredSide === "bottom" && top + tooltipHeight > scrollY + viewportHeight - padding) {
        // Not enough space on bottom, flip to top
        top = triggerRect.top + scrollY - tooltipHeight - sideOffset;
      }

      // Ensure tooltip stays within viewport vertically
      if (top < scrollY + padding) {
        top = scrollY + padding;
      }
      if (top + tooltipHeight > scrollY + viewportHeight - padding) {
        top = scrollY + viewportHeight - tooltipHeight - padding;
      }

      setPosition({ top, left });
    };

    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      updatePosition();
    });

    // Update position on scroll/resize
    const handleUpdate = () => {
      if (isVisible) {
        requestAnimationFrame(updatePosition);
      }
    };

    window.addEventListener("scroll", handleUpdate, true);
    window.addEventListener("resize", handleUpdate);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", handleUpdate, true);
      window.removeEventListener("resize", handleUpdate);
    };
  }, [isVisible, side, sideOffset]);

  return (
    <>
      <div
        ref={triggerRef}
        aria-describedby={isVisible ? tooltipId : undefined}
        className={cn("inline-block", className)}
        onMouseEnter={() =>
          isHoverAvailable && showTooltip(tooltipIdentifier, false)
        }
        onMouseLeave={() => hideTooltip()}
        onPointerDown={(e: React.PointerEvent) => {
          if (e.pointerType === "mouse") {
            setIsPointer(true);
          }
        }}
        onPointerUp={() => setIsPointer(false)}
        onFocus={() => {
          if (isHoverAvailable) {
            isPointer
              ? showTooltip(tooltipIdentifier, false)
              : showTooltip(tooltipIdentifier, true);
          } else {
            hideTooltip();
          }
        }}
        onBlur={() => hideTooltip()}
      >
        {children}
      </div>
      {isVisible && position && typeof document !== "undefined" &&
        createPortal(
          <span
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            aria-hidden={false}
            className="bg-neutral-900 text-white dark:bg-neutral-800 dark:text-neutral-100 fixed w-max rounded-md px-2 py-1 text-sm shadow-lg shadow-black/20 z-[9999] pointer-events-none"
            style={{
              top: `${position.top}px`,
              left: `${position.left}px`,
            }}
          >
            {content}
          </span>,
          document.body
        )}
    </>
  );
};
