from json.decoder import JSONDecodeError
from ssl import SSLError
from typing import TYPE_CHECKING, Union

from httpx import HTTPStatusError, NetworkError, RequestError, TimeoutException

from ..translation import _

if TYPE_CHECKING:
    from ..record import BaseLogger, LoggerManager

__all__ = [
    "capture_error_params",
    "capture_error_request",
]


def _detail(e: BaseException) -> str:
    # 诊断用：显示真实异常类型与内容，并向上追溯 __cause__/__context__
    parts = [f"{type(e).__name__}: {e!r}"]
    cur = e.__cause__ or e.__context__
    depth = 0
    while cur is not None and depth < 5:
        parts.append(f"<- {type(cur).__name__}: {cur!r}")
        cur = cur.__cause__ or cur.__context__
        depth += 1
    return " ".join(parts)


def capture_error_params(function):
    async def inner(logger: Union["BaseLogger", "LoggerManager"], *args, **kwargs):
        try:
            return await function(logger, *args, **kwargs)
        except (
            JSONDecodeError,
            UnicodeDecodeError,
        ) as e:
            logger.error(_("响应内容不是有效的 JSON 数据") + f" [{_detail(e)}]")
        except HTTPStatusError as e:
            logger.error(_("响应码异常：{error}").format(error=e))
        except NetworkError as e:
            logger.error(_("网络异常：{error}").format(error=_detail(e)))
        except TimeoutException as e:
            logger.error(_("请求超时：{error}").format(error=_detail(e)))
        except (
            RequestError,
            SSLError,
        ) as e:
            logger.error(_("网络异常：{error}").format(error=_detail(e)))
        return None

    return inner


def capture_error_request(function):
    async def inner(self, *args, **kwargs):
        try:
            return await function(self, *args, **kwargs)
        except (JSONDecodeError, UnicodeDecodeError) as e:
            self.log.error(
                _("响应内容不是有效的 JSON 数据，请尝试更新 Cookie！")
                + f" [{_detail(e)}]"
            )
        except HTTPStatusError as e:
            self.log.error(_("响应码异常：{error}").format(error=e))
        except NetworkError as e:
            self.log.error(_("网络异常：{error}").format(error=_detail(e)))
        except TimeoutException as e:
            self.log.error(_("请求超时：{error}").format(error=_detail(e)))
        except (
            RequestError,
            SSLError,
        ) as e:
            self.log.error(_("网络异常：{error}").format(error=_detail(e)))
        return None

    return inner
