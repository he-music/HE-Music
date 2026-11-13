import { computed } from "vue";
import { useBreakpoints } from "@vueuse/core";
import { screenBreakpoints, layoutBreakpoints } from "@/constants/layout";
import { platform } from "@/platform";

/** 视口宽度与布局策略分别暴露；mygo 始终保留桌面交互。 */
export const useMobile = () => {
  const breakpoints = useBreakpoints(screenBreakpoints);
  const layouts = useBreakpoints(layoutBreakpoints);
  const isSmall = layouts.smaller("small");
  const isMobile = breakpoints.smaller("sm");
  const isSmallScreen = breakpoints.smaller("md");
  const isTablet = layouts.smaller("mobilePlayer");
  const isDesktop = breakpoints.greaterOrEqual("lg");
  const isLargeDesktop = breakpoints.greaterOrEqual("xl");
  const belowMobilePlayBar = layouts.smaller("mobilePlayBar");
  const isMobilePlayBar = computed(() => platform.kind !== "mygo" && belowMobilePlayBar.value);
  const isDesktopLayout = computed(() => platform.kind === "mygo" || isDesktop.value);
  const isMobilePlayer = computed(() => platform.kind !== "mygo" && isTablet.value);

  return {
    /** 是否为小屏 (< 512px) */
    isSmall,
    /** 是否为移动端 (< 640px) */
    isMobile,
    /** 是否为小屏设备 (< 768px) */
    isSmallScreen,
    /** 是否为中等屏幕 (< 990px) */
    isTablet,
    /** 是否为桌面端 (>= 1024px) */
    isDesktop,
    /** 是否为大桌面端 (>= 1280px) */
    isLargeDesktop,
    /** 是否采用桌面导航布局（mygo 不随宽度切换为抽屉导航） */
    isDesktopLayout,
    /** 是否采用移动端播放器及歌词工具栏 */
    isMobilePlayer,
    /** 网页端窄屏播放条，mygo 保留上一曲和下一曲 */
    isMobilePlayBar,
    /** 断点实例 */
    breakpoints,
  };
};
